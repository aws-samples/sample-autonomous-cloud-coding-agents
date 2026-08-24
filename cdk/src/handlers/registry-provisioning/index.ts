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

// Custom-resource handlers that provision the standalone AWS Agent Registry
// backing ABCA's agent asset registry. Create/Delete are asynchronous, so this
// uses the CDK Provider framework: `onEvent` starts the mutation and `isComplete`
// polls until the registry reaches a stable state.
import { createHash } from 'node:crypto';
import {
  AgentRegistryControlClient,
  CreateRegistryCommand,
  GetRegistryCommand,
  UpdateRegistryCommand,
  DeleteRegistryCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-agent-registry-control';
import { logger } from '../shared/logger';
import { makeClient } from '../shared/ua';

// The Provider framework's request/response shapes are not exported from
// aws-cdk-lib's public entrypoints, so we model the fields we use.
interface OnEventRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  /** CloudFormation request id — stable per logical CFN operation, so it makes a
   *  good idempotency token for the async CreateRegistry (Provider handlers are
   *  delivered at-least-once). Always present in Provider-framework events. */
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

// Route through makeClient so the ABCA solution UA segment is attached (#319);
// a naked `new AgentRegistryControlClient({})` silently drops attribution.
const client = makeClient(AgentRegistryControlClient);

/** clientToken length cap — a 64-hex-char (256-bit) prefix of the SHA-256 digest
 *  is plenty of entropy for an idempotency token and stays within API limits. */
const CLIENT_TOKEN_LENGTH = 64;

/** The registry id is the last ARN segment; we also accept a bare id. */
function registryIdFromArn(arn: string): string {
  return arn.includes('/') ? arn.split('/').pop()! : arn;
}

/** A deterministic, charset-safe idempotency token for CreateRegistry. Derived
 *  from the stable CFN RequestId (falls back to the registry name if absent) so
 *  an at-least-once retry of the same logical create is a substrate no-op rather
 *  than a duplicate registry. */
function createTokenFrom(requestId: string | undefined, registryName: string): string {
  return createHash('sha256').update(`${requestId ?? ''}:${registryName}`).digest('hex').slice(0, CLIENT_TOKEN_LENGTH);
}

export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  logger.info('registry-provisioning onEvent', { requestType: event.RequestType });
  switch (event.RequestType) {
    case 'Create': {
      const { RegistryName, Description } = event.ResourceProperties;
      // Idempotency: Provider handlers are delivered at-least-once, so a lost
      // response after a successful CreateRegistry would, on retry, create a
      // *second* registry and strand the stack. A clientToken derived from the
      // stable CFN RequestId makes the retry a no-op on the substrate side.
      const res = await client.send(
        new CreateRegistryCommand({
          name: RegistryName,
          description: Description,
          clientToken: createTokenFrom(event.RequestId, RegistryName),
        }),
      );
      const registryId = registryIdFromArn(res.registryArn!);
      // PhysicalResourceId drives isComplete + delete; carry the id there.
      return { PhysicalResourceId: registryId, Data: { RegistryId: registryId, RegistryArn: res.registryArn! } };
    }
    case 'Update': {
      // Apply the desired state instead of silently reporting success. Both
      // exposed props are mutable in place via UpdateRegistry (the registry id
      // is stable across a rename), so no replacement is needed — the physical
      // id is unchanged. Previously this branch sent no SDK command, so a
      // changed RegistryName/Description left CloudFormation reporting success
      // while the managed registry kept its old values.
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
      const registryId = event.PhysicalResourceId!;
      try {
        await client.send(new DeleteRegistryCommand({ registryId }));
      } catch (err) {
        if (err instanceof ResourceNotFoundException) {
          return { PhysicalResourceId: registryId };
        }
        throw err;
      }
      return { PhysicalResourceId: registryId };
    }
  }
}

export async function isComplete(event: IsCompleteRequest): Promise<IsCompleteResponse> {
  const registryId = event.PhysicalResourceId;
  if (event.RequestType === 'Delete') {
    try {
      const res = await client.send(new GetRegistryCommand({ registryId }));
      if (res.status === 'DELETE_FAILED') {
        throw new Error(
          `Registry ${registryId} entered DELETE_FAILED: ${res.statusReason ?? 'no reason given'}`,
        );
      }
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return { IsComplete: true };
      throw err;
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
