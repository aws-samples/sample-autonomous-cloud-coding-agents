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
  ValidationException,
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

/** The `registryId` constraint enforced by the Agent Registry control plane, which
 *  accepts a bare id or a full registry ARN. Mirrored here so a physical id that never
 *  came from CreateRegistry can be recognised locally instead of costing a round-trip
 *  that fails closed as a ValidationException.
 *
 *  The upper bound is deliberately looser than the service's current `{12,16}`. This is
 *  a *positive* discriminator — anything it fails to match is treated as never-created
 *  and skipped — so if AWS ever widens the id format, a tight bound here would silently
 *  orphan real registries while CloudFormation reported DELETE_COMPLETE.
 *
 *  Erring wide is the cheaper direction: an id this admits but the service rejects
 *  raises a ValidationException, which both Delete paths treat as absent, so the cost is
 *  a rejected call and a warn. Erring narrow leaks a billable resource silently. */
const REGISTRY_ID_PATTERN
  = /^(arn:aws(-[^:]+)?:agent-registry:[a-z0-9-]+:[0-9]{12}:registry\/)?[a-zA-Z0-9]{12,64}$/;

/** Whether `physicalId` is shaped like something the control plane would accept.
 *
 * CloudFormation still issues a Delete during rollback for a resource whose Create
 * never returned — so the physical id may be a CFN placeholder rather than a registry
 * id. Deleting by that id is not merely useless, it wedges the stack: the control
 * plane rejects it with a ValidationException, which is neither "absent" nor
 * retryable, so the resource lands in DELETE_FAILED and the enclosing stack can only
 * be removed with `--retain-resources`.
 *
 * Returns a plain boolean rather than a `physicalId is string` predicate on purpose. A
 * predicate would narrow the *false* branch to `undefined`, which is where both callers
 * do their work — so the placeholder they log would be typed away despite being a
 * non-empty string at runtime. */
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
    // Defence in depth behind the shape guard, and deliberately Delete-only. The guard
    // fails *open* on format drift (skips the call, leaks the registry); this fails open
    // on a request the service rejects (recoverable, and visible in the log). They fail
    // in opposite directions, so keeping both narrows the window either leaves. Create
    // and Update stay strictly fail-closed, where a malformed request is a real defect
    // that should fail the resource rather than be swallowed.
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
      const physicalId = event.PhysicalResourceId;
      // The framework already handles the clean case: `safeHandler` answers SUCCESS for a
      // Delete whose physical id is CREATE_FAILED_PHYSICAL_ID_MARKER without invoking this
      // handler at all, so a create that failed *inside onEvent* never reaches here.
      //
      // The gap is a create that never returned a physical id and never got that marker:
      // when a sibling resource fails first, CloudFormation stops waiting on this one and
      // marks it CREATE_FAILED, then rollback issues a Delete carrying whatever id it has
      // — a MISSING_PHYSICAL_ID marker or another placeholder. Recognise that here rather
      // than letting the control plane reject it and wedge the stack.
      if (!isRegistryId(physicalId)) {
        // Inference, not a certainty: CloudFormation abandons the create rather than
        // killing the Lambda, so CreateRegistry may have succeeded with its response
        // going to a ResponseURL nobody reads. Skipping the delete can therefore orphan
        // a real, billable registry — still the right trade against an unrecoverable
        // stack, but warn-level because it is a leak, not a clean no-op.
        logger.warn('registry delete skipped: physical id is not registry-shaped', {
          physicalId,
          registryName: event.ResourceProperties.RegistryName,
        });
        // Echo the id verbatim — never synthesize one. The Provider framework rejects a
        // Delete response whose PhysicalResourceId differs from the request's, so
        // inventing a value here would throw and produce the very DELETE_FAILED this
        // branch exists to avoid. Returning `undefined` lets its own
        // `defaultPhysicalResourceId` supply the request's value.
        return { PhysicalResourceId: physicalId };
      }
      // Normalise before the SDK call, matching what the Create branch stores. The
      // service accepts either shape, so this is consistency rather than a fix — but it
      // keeps a single form flowing to the API while the returned PhysicalResourceId
      // stays byte-identical to the request, as the framework requires.
      await requestRegistryDeletion(registryIdFromArn(physicalId!));
      return { PhysicalResourceId: physicalId };
    }
  }
}

export async function isComplete(event: IsCompleteRequest): Promise<IsCompleteResponse> {
  if (event.RequestType === 'Delete') {
    // Mirror onEvent's guard: the Provider polls isComplete after onEvent, so a
    // never-created registry would otherwise reach GetRegistry with a placeholder id
    // and fail closed here instead — the same DELETE_FAILED wedge, one step later.
    // Logged for the same reason as onEvent's: reporting a delete complete without
    // calling the service may be leaving a real registry behind.
    //
    // Ordered before any normalisation deliberately. `registryIdFromArn` dereferences
    // its argument, so normalising first would throw on an absent id instead of taking
    // this branch — the declared type says that cannot happen, but the guard is here
    // precisely for ids the declared type did not anticipate.
    if (!isRegistryId(event.PhysicalResourceId)) {
      logger.warn('registry delete reported complete unverified: physical id is not registry-shaped', {
        physicalId: event.PhysicalResourceId,
        registryName: event.ResourceProperties.RegistryName,
      });
      return { IsComplete: true };
    }

    // Normalise so a full ARN and a bare id reach the API identically, matching onEvent.
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
      // Same fail-open as the delete path, and for the same reason: an id the guard
      // admitted but the service rejects is not worth wedging the stack over. Without
      // this, the widened bound could cost more than "one rejected API call" — it would
      // rethrow into DELETE_FAILED. Delete-only; the Create/Update poll below stays
      // fail-closed.
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

    // The initial DeleteRegistry call may have been throttled or conflicted
    // before deletion started. Re-drive it until the service reports DELETING.
    const attempt = await requestRegistryDeletion(registryId);
    if (attempt === 'absent') return { IsComplete: true };
    return { IsComplete: false };
  }

  // Create / Update: wait for READY. Normalised for the same reason as the Delete path,
  // and fail-closed throughout — on these paths a rejected id is a real defect.
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
