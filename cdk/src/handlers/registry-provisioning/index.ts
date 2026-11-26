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
  AgentRegistryControlClient,
  ConflictException,
  CreateRegistryCommand,
  DeleteRegistryCommand,
  DeleteRegistryRecordCommand,
  GetRegistryCommand,
  InternalServerException,
  ListRegistryRecordsCommand,
  ResourceNotFoundException,
  ThrottlingException,
  UpdateRegistryCommand,
  ValidationException,
} from '@aws-sdk/client-agent-registry-control';
import { logger } from '../shared/logger';
import { makeClient } from '../shared/ua';

// aws-cdk-lib does not export the Provider framework's request and response types.
interface OnEventRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly RequestId?: string;
  readonly ResourceProperties: { readonly RegistryName: string; readonly Description?: string };
  readonly OldResourceProperties?: { readonly RegistryName?: string; readonly Description?: string };
}
interface OnEventResponse {
  readonly PhysicalResourceId?: string;
  readonly Data?: Record<string, string>;
}
interface IsCompleteRequest extends OnEventRequest {
  readonly PhysicalResourceId: string;
}
interface IsCompleteResponse {
  readonly IsComplete: boolean;
  readonly Data?: Record<string, string>;
}

const client = makeClient(AgentRegistryControlClient);

const CLIENT_TOKEN_LENGTH = 64;

const RECORD_DELETION_BUDGET_MS = 30_000;

type DeleteAttempt = 'absent' | 'pending';

function registryIdFromArn(arn: string): string {
  return arn.includes('/') ? arn.split('/').pop()! : arn;
}

const REGISTRY_ID_PATTERN
  = /^(arn:aws(-[^:]+)?:agent-registry:[a-z0-9-]+:[0-9]{12}:registry\/)?[a-zA-Z0-9]{12,64}$/;

function isRegistryId(physicalId: string | undefined): boolean {
  return physicalId !== undefined && REGISTRY_ID_PATTERN.test(physicalId);
}

function isRetryableDeleteError(err: unknown): boolean {
  return (
    err instanceof ConflictException
    || err instanceof ThrottlingException
    || err instanceof InternalServerException
  );
}

async function deleteRegistryRecords(registryId: string): Promise<void> {
  const deadline = Date.now() + RECORD_DELETION_BUDGET_MS;
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListRegistryRecordsCommand({ registryId, nextToken }));
    for (const { recordId } of page.registryRecords ?? []) {
      if (Date.now() > deadline) return;
      try {
        await client.send(new DeleteRegistryRecordCommand({ registryId, recordId }));
      } catch (err) {
        if (!(err instanceof ConflictException) && !(err instanceof ResourceNotFoundException)) throw err;
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
}

async function requestRegistryDeletion(registryId: string): Promise<DeleteAttempt> {
  try {
    await deleteRegistryRecords(registryId);
    await client.send(new DeleteRegistryCommand({ registryId }));
    return 'pending';
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return 'absent';
    if (err instanceof ValidationException) {
      logger.warn('registry delete treated as absent: service rejected the id', {
        registryId,
        error: String(err),
      });
      return 'absent';
    }
    if (isRetryableDeleteError(err)) {
      logger.warn('registry deletion will be retried', {
        registryId,
        error: String(err),
      });
      return 'pending';
    }
    throw err;
  }
}

function createTokenFrom(requestId: string | undefined, registryName: string): string {
  return createHash('sha256').update(`${requestId ?? ''}:${registryName}`).digest('hex').slice(0, CLIENT_TOKEN_LENGTH);
}

export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  logger.info('registry-provisioning onEvent', { requestType: event.RequestType });
  switch (event.RequestType) {
    case 'Create': {
      const { RegistryName, Description } = event.ResourceProperties;
      const res = await client.send(
        new CreateRegistryCommand({
          name: RegistryName,
          description: Description,
          clientToken: createTokenFrom(event.RequestId, RegistryName),
        }),
      );
      const registryId = registryIdFromArn(res.registryArn!);
      return { PhysicalResourceId: registryId, Data: { RegistryId: registryId, RegistryArn: res.registryArn! } };
    }
    case 'Update': {
      const registryId = event.PhysicalResourceId!;
      const { RegistryName, Description } = event.ResourceProperties;
      const old = event.OldResourceProperties ?? {};
      const nameChanged = RegistryName !== old.RegistryName;
      const descChanged = Description !== old.Description;
      if (nameChanged || descChanged) {
        await client.send(
          new UpdateRegistryCommand({
            registryId,
            ...(nameChanged && { name: RegistryName }),
            // The description update is a wrapper: an absent optionalValue clears it.
            ...(descChanged && { description: { optionalValue: Description } }),
          }),
        );
      }
      return { PhysicalResourceId: registryId };
    }
    case 'Delete': {
      const physicalId = event.PhysicalResourceId;
      // CloudFormation sends a Delete on rollback for a resource whose Create never
      // returned: its physical id is then a placeholder, not a registry id.
      if (!isRegistryId(physicalId)) {
        logger.warn('registry delete skipped: physical id is not registry-shaped', {
          physicalId,
          registryName: event.ResourceProperties.RegistryName,
        });
        // The Provider framework rejects a Delete response whose PhysicalResourceId
        // differs from the request's.
        return { PhysicalResourceId: physicalId };
      }
      await requestRegistryDeletion(registryIdFromArn(physicalId!));
      return { PhysicalResourceId: physicalId };
    }
  }
}

export async function isComplete(event: IsCompleteRequest): Promise<IsCompleteResponse> {
  if (event.RequestType === 'Delete') {
    if (!isRegistryId(event.PhysicalResourceId)) {
      logger.warn('registry delete reported complete unverified: physical id is not registry-shaped', {
        physicalId: event.PhysicalResourceId,
        registryName: event.ResourceProperties.RegistryName,
      });
      return { IsComplete: true };
    }

    const registryId = registryIdFromArn(event.PhysicalResourceId);

    let status: string;
    let statusReason: string | undefined;
    try {
      const res = await client.send(new GetRegistryCommand({ registryId }));
      status = res.status ?? '';
      statusReason = res.statusReason;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return { IsComplete: true };
      if (isRetryableDeleteError(err)) return { IsComplete: false };
      if (err instanceof ValidationException) {
        logger.warn('registry delete treated as complete: service rejected the id', {
          registryId,
          error: String(err),
        });
        return { IsComplete: true };
      }
      throw err;
    }

    if (status === 'DELETE_FAILED') {
      throw new Error(
        `Registry ${registryId} entered DELETE_FAILED: ${statusReason ?? 'no reason given'}`,
      );
    }
    if (status === 'DELETING') return { IsComplete: false };

    const attempt = await requestRegistryDeletion(registryId);
    if (attempt === 'absent') return { IsComplete: true };
    return { IsComplete: false };
  }

  const registryId = registryIdFromArn(event.PhysicalResourceId);
  const res = await client.send(new GetRegistryCommand({ registryId }));
  const status = res.status ?? '';
  if (status === 'READY') {
    return { IsComplete: true, Data: { RegistryId: registryId, RegistryArn: res.registryArn! } };
  }
  if (status.includes('FAILED')) {
    throw new Error(`Registry ${registryId} entered ${status}: ${res.statusReason ?? 'no reason given'}`);
  }
  return { IsComplete: false };
}
