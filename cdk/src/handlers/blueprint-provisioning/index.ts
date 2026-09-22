/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

import { createHash } from 'node:crypto';
import {
  AttributeValue, DynamoDBClient, GetItemCommand, TransactWriteItem, TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import { ASSET_FIELDS, parseConfiguration, REPO_PATTERN } from '../../blueprints/configuration';
import { makeClient } from '../shared/ua';

const client = makeClient(DynamoDBClient);
const MAX_ATTEMPTS = 4;
const REMOVAL_TTL_DAYS = 30;
const REMOVAL_TTL_SECONDS = REMOVAL_TTL_DAYS * 24 * 60 * 60;
const MILLISECONDS_PER_SECOND = 1000;
const PHYSICAL_ID = /^blueprint-v2:([a-f0-9]{64}):([a-f0-9]{64})$/;

interface Properties {
  TableName: string;
  Repo: string;
  Configuration: string;
  Mode: 'adopt' | 'managed';
}
export interface BlueprintEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  StackId: string;
  LogicalResourceId: string;
  RequestId: string;
  PhysicalResourceId?: string;
  ResourceProperties: Properties;
}
interface Ownership {
  owner: string;
  family: string;
  revision: number;
  mode: 'adopt' | 'managed';
  state: 'active' | 'removed';
}

function hash(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function ownership(item?: Record<string, AttributeValue>): Ownership | undefined {
  if (!item) return undefined;
  const owner = item.owner?.S;
  const family = item.family?.S;
  const revision = Number(item.revision?.N);
  const mode = item.mode?.S;
  const state = item.state?.S;
  if (!owner || !PHYSICAL_ID.test(owner) || !family || !Number.isSafeInteger(revision) || revision < 1 ||
    (mode !== 'adopt' && mode !== 'managed') || (state !== 'active' && state !== 'removed')) {
    throw new Error('Invalid blueprint ownership ledger entry; reconciliation is required');
  }
  return { owner, family, revision, mode, state };
}

function retryableTransaction(error: unknown): boolean {
  const candidate = error as { name?: string; CancellationReasons?: { Code?: string }[] };
  return candidate?.name === 'TransactionCanceledException' && !!candidate.CancellationReasons?.length &&
    candidate.CancellationReasons.some(reason => reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict') &&
    candidate.CancellationReasons.every(reason =>
      reason.Code === 'None' || reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict');
}

/** Provider-framework callback. One transaction owns the row mutation and its durable retry receipt. */
export async function onEvent(event: BlueprintEvent): Promise<{ PhysicalResourceId: string }> {
  const props = event.ResourceProperties;
  if (!props || !/^[a-zA-Z0-9_.-]{3,255}$/.test(props.TableName ?? '') || !REPO_PATTERN.test(props.Repo ?? '') ||
    (props.Mode !== 'adopt' && props.Mode !== 'managed') ||
    !event.StackId || !event.LogicalResourceId || !event.RequestId ||
    !['Create', 'Update', 'Delete'].includes(event.RequestType)) {
    throw new Error('Invalid blueprint provisioning event');
  }
  const ledgerTable = process.env.OWNERSHIP_TABLE;
  if (!ledgerTable) throw new Error('OWNERSHIP_TABLE is required');
  const target = hash(props.TableName, props.Repo);
  const family = hash(event.StackId, event.LogicalResourceId);
  const previous = event.PhysicalResourceId?.match(PHYSICAL_ID);
  if (event.RequestType === 'Delete' && !previous) {
    // The framework normally intercepts failed-Create placeholders itself.
    if (!event.PhysicalResourceId) throw new Error('Delete requires a physical resource ID');
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  if (event.RequestType === 'Update' && !previous) throw new Error('Update requires a managed blueprint physical ID');
  if (event.RequestType === 'Delete' && previous![1] !== target) throw new Error('Blueprint delete target does not match its physical ID');
  const claiming = event.RequestType === 'Create' || (event.RequestType === 'Update' && previous![1] !== target);
  const physicalId = claiming ? `blueprint-v2:${target}:${hash(family, event.RequestId)}` : event.PhysicalResourceId!;
  const response = { PhysicalResourceId: physicalId };
  // Adoption is deliberately non-destructive, including rollback of a failed cutover.
  if (event.RequestType === 'Delete' && props.Mode === 'adopt') return response;
  const configuration = event.RequestType === 'Delete' ? {} : parseConfiguration(props.Configuration);
  const ledgerKey = { target: { S: `target:${target}` } };
  const receiptKey = { target: { S: `request:${hash(family, event.RequestId)}` } };

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const receipt = await client.send(new GetItemCommand({ TableName: ledgerTable, Key: receiptKey, ConsistentRead: true }));
    if (receipt.Item) {
      if (receipt.Item.physical_id?.S !== physicalId || receipt.Item.request_type?.S !== event.RequestType) {
        throw new Error('Blueprint retry does not match its recorded operation');
      }
      return response;
    }
    const result = await client.send(new GetItemCommand({ TableName: ledgerTable, Key: ledgerKey, ConsistentRead: true }));
    const current = ownership(result.Item);
    if (event.RequestType === 'Delete') {
      if (!current || current.owner !== physicalId || current.mode === 'adopt' || current.state === 'removed') return response;
    } else if (claiming) {
      if (current && current.family !== family && current.state === 'active') {
        throw new Error('Repository is owned by another active Blueprint');
      }
    } else if (!current || current.owner !== physicalId || current.state !== 'active') {
      throw new Error('Blueprint no longer owns this repository; reconciliation is required');
    }

    const now = new Date();
    const names: Record<string, string> = { '#status': 'status', '#updated': 'updated_at', '#ttl': 'ttl' };
    const values: Record<string, AttributeValue> = {
      ':status': { S: event.RequestType === 'Delete' ? 'removed' : 'active' },
      ':now': { S: now.toISOString() },
    };
    let expression = 'SET #status = :status, #updated = :now';
    if (event.RequestType === 'Delete') {
      expression += ', #ttl = :ttl';
      values[':ttl'] = { N: String(Math.floor(now.getTime() / MILLISECONDS_PER_SECOND) + REMOVAL_TTL_SECONDS) };
    } else {
      names['#onboarded'] = 'onboarded_at';
      expression += ', #onboarded = if_not_exists(#onboarded, :now)';
      for (const [key, value] of Object.entries(configuration)) {
        names[`#${key}`] = key;
        values[`:${key}`] = value;
        expression += `, #${key} = :${key}`;
      }
      const removed: string[] = ['#ttl'];
      for (const key of ASSET_FIELDS.filter(field => !configuration[field])) {
        names[`#${key}`] = key;
        removed.push(`#${key}`);
      }
      expression += ` REMOVE ${removed.join(', ')}`;
    }
    const requireFresh = claiming && props.Mode === 'managed' && current?.family !== family;
    if (requireFresh) names['#repo'] = 'repo';
    let repoOperation: TransactWriteItem = {
      Update: {
        TableName: props.TableName,
        Key: { repo: { S: props.Repo } },
        UpdateExpression: expression,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ...(requireFresh ? { ConditionExpression: 'attribute_not_exists(#repo)' } : {}),
      },
    };
    if (event.RequestType === 'Delete') {
      // Do not create a tombstone if TTL/manual cleanup already removed the row.
      const repo = await client.send(new GetItemCommand({
        TableName: props.TableName, Key: { repo: { S: props.Repo } }, ConsistentRead: true,
      }));
      repoOperation = repo.Item ? {
        Update: {
          ...repoOperation.Update!,
          ConditionExpression: 'attribute_exists(#repo)',
          ExpressionAttributeNames: { ...names, '#repo': 'repo' },
        },
      } : {
        ConditionCheck: {
          TableName: props.TableName,
          Key: { repo: { S: props.Repo } },
          ConditionExpression: 'attribute_not_exists(#repo)',
          ExpressionAttributeNames: { '#repo': 'repo' },
        },
      };
    }
    const ledgerValues: Record<string, AttributeValue> = {
      ':owner': { S: physicalId },
      ':family': { S: family },
      ':mode': { S: props.Mode },
      ':state': { S: event.RequestType === 'Delete' ? 'removed' : 'active' },
      ':revision': { N: String((current?.revision ?? 0) + 1) },
      ...(current ? { ':previous': { N: String(current.revision) } } : {}),
    };
    try {
      await client.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Update: {
              TableName: ledgerTable,
              Key: ledgerKey,
              UpdateExpression: 'SET #owner = :owner, #family = :family, #mode = :mode, #state = :state, #revision = :revision',
              ConditionExpression: current ? '#revision = :previous' : 'attribute_not_exists(#target)',
              ExpressionAttributeNames: {
                '#owner': 'owner',
                '#family': 'family',
                '#mode': 'mode',
                '#state': 'state',
                '#revision': 'revision',
                ...(!current ? { '#target': 'target' } : {}),
              },
              ExpressionAttributeValues: ledgerValues,
            },
          },
          repoOperation,
          {
            Put: {
              TableName: ledgerTable,
              Item: { ...receiptKey, physical_id: { S: physicalId }, request_type: { S: event.RequestType } },
              ConditionExpression: 'attribute_not_exists(#target)',
              ExpressionAttributeNames: { '#target': 'target' },
            },
          },
        ],
      }));
      return response;
    } catch (error) {
      if (!retryableTransaction(error)) throw error;
      const reasons = (error as { CancellationReasons: { Code: string }[] }).CancellationReasons;
      // A concurrent delivery may already have committed this same create.
      // Reread its receipt if ownership or receipt conditions also failed.
      if (requireFresh && reasons[1]?.Code === 'ConditionalCheckFailed' &&
        reasons[0]?.Code === 'None' && reasons[2]?.Code === 'None') {
        throw new Error('Existing repository requires the prepare/adopt blueprint handoff');
      }
    }
  }
  throw new Error('Blueprint transaction could not acquire ownership; existing repositories require the prepare/adopt handoff, and concurrent operations must finish first');
}
