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
  ConflictException,
  CreateRegistryCommand,
  DeleteRegistryCommand,
  GetRegistryCommand,
  InternalServerException,
  ResourceNotFoundException,
  ThrottlingException,
  UpdateRegistryCommand,
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

type DeleteAttempt = 'started' | 'absent' | 'retryable';

/** The registry id is the last ARN segment; we also accept a bare id. */
function registryIdFromArn(arn: string): string {
  return arn.includes('/') ? arn.split('/').pop()! : arn;
}

function isRetryableDeleteError(err: unknown): boolean {
  return (
    err instanceof ConflictException
    || err instanceof ThrottlingException
    || err instanceof InternalServerException
  );
}

/**
 * Start or re-drive asynchronous deletion.
 *
 * A retryable service error is ambiguous: the request may have reached the
 * service even though the response did not reach us. Returning `retryable`
 * lets the Provider waiter observe the current state and re-issue the
 * idempotent delete when the registry is not already DELETING.
 */
async function requestRegistryDeletion(registryId: string): Promise<DeleteAttempt> {
  try {
    await client.send(new DeleteRegistryCommand({ registryId }));
    return 'started';
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return 'absent';
    if (isRetryableDeleteError(err)) {
      logger.warn('registry deletion will be retried', {
        registryId,
        error: String(err),
      });
      return 'retryable';
    }
    throw err;
  }
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
      // The CDK Provider wrapper consumes its CREATE_FAILED marker before
      // invoking this handler, so a validation error here is a real defect and
      // must not be treated as an already-absent registry.
      await requestRegistryDeletion(registryId);
      return { PhysicalResourceId: registryId };
    }
  }
}

export async function isComplete(event: IsCompleteRequest): Promise<IsCompleteResponse> {
  const registryId = event.PhysicalResourceId;
  if (event.RequestType === 'Delete') {
    let status: string;
    let statusReason: string | undefined;
    try {
      const res = await client.send(new GetRegistryCommand({ registryId }));
      status = res.status ?? '';
      statusReason = res.statusReason;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return { IsComplete: true };
      if (isRetryableDeleteError(err)) return { IsComplete: false };
      throw err;
    }

    if (status === 'DELETE_FAILED') {
      throw new Error(
        `Registry ${registryId} entered DELETE_FAILED: ${statusReason ?? 'no reason given'}`,
      );
    }
    if (status === 'DELETING') return { IsComplete: false };

    // The initial DeleteRegistry call may have been throttled or conflicted
    // before deletion started. Re-drive it until the service reports DELETING.
    const attempt = await requestRegistryDeletion(registryId);
    if (attempt === 'absent') return { IsComplete: true };
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
