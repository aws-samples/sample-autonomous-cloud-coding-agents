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

// Custom-resource handlers that provision the AgentCore registry that backs the
// agent asset registry (#246). CreateRegistry is asynchronous (CREATING -> READY,
// ~70s observed), so this uses the CDK Provider framework: `onEvent` kicks off the
// mutation and `isComplete` is polled until the registry reaches a stable state.
//
// GA-THROWAWAY: swap this for the native AgentCore CDK L1/L2 construct once it
// ships (~2026-08-06). The `RegistryClient` seam keeps that swap confined.
import {
  BedrockAgentCoreControlClient,
  CreateRegistryCommand,
  GetRegistryCommand,
  DeleteRegistryCommand,
  ListRegistryRecordsCommand,
  DeleteRegistryRecordCommand,
  ConflictException,
  ResourceNotFoundException,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { logger } from '../shared/logger';

// The Provider framework's request/response shapes are not exported from
// aws-cdk-lib's public entrypoints, so we model the fields we use.
interface OnEventRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: { readonly RegistryName: string; readonly Description?: string };
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

const client = new BedrockAgentCoreControlClient({});

/** The registry id is the last ARN segment; we also accept a bare id. */
function registryIdFromArn(arn: string): string {
  return arn.includes('/') ? arn.split('/').pop()! : arn;
}

export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  logger.info('registry-provisioning onEvent', { requestType: event.RequestType });
  switch (event.RequestType) {
    case 'Create': {
      const { RegistryName, Description } = event.ResourceProperties;
      const res = await client.send(
        new CreateRegistryCommand({ name: RegistryName, description: Description }),
      );
      const registryId = registryIdFromArn(res.registryArn!);
      // PhysicalResourceId drives isComplete + delete; carry the id there.
      return { PhysicalResourceId: registryId, Data: { RegistryId: registryId, RegistryArn: res.registryArn! } };
    }
    case 'Update': {
      // The registry name is immutable in this design; a name change would force
      // replacement (new PhysicalResourceId) via CreateRegistry on the new value.
      // Nothing to mutate in place, so echo the existing id back.
      return { PhysicalResourceId: event.PhysicalResourceId };
    }
    case 'Delete': {
      const registryId = event.PhysicalResourceId!;
      // If Create never succeeded the id is a CFN-generated token, not a real
      // registry — GetRegistry will 404 and isComplete short-circuits.
      await drainRecords(registryId);
      try {
        await client.send(new DeleteRegistryCommand({ registryId }));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) {
          return { PhysicalResourceId: registryId };
        }
        // Records may still be settling; isComplete will retry the delete.
        if (!(err instanceof ConflictException)) throw err;
      }
      return { PhysicalResourceId: registryId };
    }
  }
}

export async function isComplete(event: IsCompleteRequest): Promise<IsCompleteResponse> {
  const registryId = event.PhysicalResourceId;
  if (event.RequestType === 'Delete') {
    try {
      await client.send(new GetRegistryCommand({ registryId }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return { IsComplete: true };
      throw err;
    }
    // Still present — keep draining + deleting until it's gone.
    await drainRecords(registryId);
    try {
      await client.send(new DeleteRegistryCommand({ registryId }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return { IsComplete: true };
      if (!(err instanceof ConflictException)) throw err;
    }
    return { IsComplete: false };
  }

  // Create / Update: wait for READY.
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

/**
 * Delete every record in a registry so the registry itself can be deleted
 * (DeleteRegistry ConflictExceptions while records exist). Records are also
 * async and eventually consistent in List; best-effort per invocation, with
 * isComplete re-invoking until the registry is empty.
 */
async function drainRecords(registryId: string): Promise<void> {
  let nextToken: string | undefined;
  do {
    let page;
    try {
      page = await client.send(new ListRegistryRecordsCommand({ registryId, nextToken, maxResults: 50 }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return;
      throw err;
    }
    const records = page.registryRecords ?? [];
    for (const rec of records) {
      const recordId = rec.recordArn ? registryIdFromArn(rec.recordArn) : rec.recordId;
      if (!recordId) continue;
      try {
        await client.send(new DeleteRegistryRecordCommand({ registryId, recordId }));
      } catch (err) {
        // CREATING/UPDATING records reject delete; isComplete retries next poll.
        if (!(err instanceof ConflictException) && !(err instanceof ResourceNotFoundException)) throw err;
      }
    }
    nextToken = page.nextToken;
  } while (nextToken);
}
