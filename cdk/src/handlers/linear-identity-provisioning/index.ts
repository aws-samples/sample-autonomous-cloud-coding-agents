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

// Custom-resource handler that provisions the AgentCore Identity *workload
// identity* backing the Linear OAuth token vault (RFC #249 Phase 1).
//
// A workload identity is the AgentCore-side identity a task presents to the
// Token Vault. It carries the allowlist of return URLs the 3LO
// (USER_FEDERATION) consent flow is permitted to bounce back to — both the
// hosted onboarding page and the CLI localhost loopback (spike findings F8/F9/
// F11: the return URL is mandatory, allowlist-enforced, and multiple entries
// coexist so the caller picks per-call).
//
// Unlike the Agent Registry (registry.ts), Create/Delete of a workload identity
// are *synchronous* — the spike showed an immediate response — so this uses a
// single `onEvent` handler with no `isComplete` poller. The CustomOauth2
// credential *provider* (which needs the admin's Linear client id/secret) is
// NOT created here; it is created at runtime by `bgagent linear setup`, since
// those credentials only exist at onboarding time.
import {
  BedrockAgentCoreControlClient,
  ConflictException,
  CreateWorkloadIdentityCommand,
  DeleteWorkloadIdentityCommand,
  GetWorkloadIdentityCommand,
  ResourceNotFoundException,
  UpdateWorkloadIdentityCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { logger } from '../shared/logger';
import { makeClient } from '../shared/ua';

// The Provider framework's request/response shapes are not exported from
// aws-cdk-lib's public entrypoints, so we model the fields we use.
interface OnEventRequest {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties: {
    readonly WorkloadName: string;
    /** JSON-encoded string[] of allowed return URLs (CFN properties are strings). */
    readonly AllowedReturnUrls?: string;
  };
}
interface OnEventResponse {
  readonly PhysicalResourceId?: string;
  readonly Data?: Record<string, string>;
}

// Route through makeClient so the ABCA solution UA segment is attached (#319);
// a naked `new BedrockAgentCoreControlClient({})` silently drops attribution.
const client = makeClient(BedrockAgentCoreControlClient);

/**
 * Decode the JSON-encoded return-URL allowlist from the CloudFormation property.
 *
 * THROWS on missing or malformed input rather than falling back to empty. An empty
 * allowlist is not a harmless default: the workload identity is provisioned — or, on
 * an Update, REWRITTEN — with no permitted consent-callback URL, and every consent
 * from then on fails the allowlist. The operator gets a broken OAuth flow attached to
 * a stack that deployed green, which is the worst possible place to be quiet. Only
 * Create and Update call this, so a throw fails the resource it describes and never
 * blocks a stack deletion.
 *
 * An explicitly empty array is passed through — that is the caller asking for none,
 * not a parse failure.
 */
function parseReturnUrls(raw?: string): string[] {
  const refuse = (reason: string): never => {
    throw new Error(
      `AllowedReturnUrls ${reason} — refusing to provision a workload identity with no `
      + 'consent-callback allowlist, which would fail every consent',
    );
  };
  if (raw === undefined) return refuse('is missing');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return refuse(`is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed) || !parsed.every((u) => typeof u === 'string')) {
    return refuse('is not a JSON array of strings');
  }
  return parsed;
}

/**
 * True when a create failed only because the workload identity already exists,
 * so the caller can fall back to update-in-place and stay idempotent.
 *
 * AgentCore reports a duplicate name as a **`ValidationException`**
 * ("WorkloadIdentity with name '<name>' already exists."), NOT the
 * `ConflictException` the name suggests — verified against the live service.
 * Without this, the SECOND deploy fails: CloudFormation sends an Update, the
 * handler re-issues Create, and the unhandled duplicate error rolls the stack
 * back. `ConflictException` is still accepted in case the service tightens this
 * later, and the message check keeps genuine validation errors (bad return URL,
 * malformed name) surfacing instead of being silently treated as "exists".
 */
function isAlreadyExistsError(err: unknown): boolean {
  if (err instanceof ConflictException) return true;
  const name = (err as { name?: string } | undefined)?.name;
  const message = (err as { message?: string } | undefined)?.message ?? '';
  return name === 'ValidationException' && /already exists/i.test(message);
}

/**
 * Create or update the workload identity. If the name already exists (a retried
 * Create after a partial success, or a stack re-deploy), fall back to
 * update-in-place — which also reconciles the return-URL allowlist when it
 * changes between deploys.
 */
async function upsertWorkloadIdentity(name: string, returnUrls: string[]): Promise<void> {
  try {
    await client.send(
      new CreateWorkloadIdentityCommand({
        name,
        allowedResourceOauth2ReturnUrls: returnUrls,
      }),
    );
    logger.info('Created workload identity', { name, returnUrlCount: returnUrls.length });
  } catch (err) {
    if (isAlreadyExistsError(err)) {
      await client.send(
        new UpdateWorkloadIdentityCommand({
          name,
          allowedResourceOauth2ReturnUrls: returnUrls,
        }),
      );
      logger.info('Workload identity existed; updated return-URL allowlist', {
        name,
        returnUrlCount: returnUrls.length,
      });
      return;
    }
    throw err;
  }
}

export async function onEvent(event: OnEventRequest): Promise<OnEventResponse> {
  const name = event.ResourceProperties.WorkloadName;
  logger.info('Linear identity provisioning event', { requestType: event.RequestType, name });

  switch (event.RequestType) {
    case 'Create':
    case 'Update': {
      const returnUrls = parseReturnUrls(event.ResourceProperties.AllowedReturnUrls);
      await upsertWorkloadIdentity(name, returnUrls);
      // The workload name is a stable natural id; use it as the physical id so
      // CloudFormation does not treat a no-op update as a replacement.
      return { PhysicalResourceId: name, Data: { WorkloadName: name } };
    }
    case 'Delete': {
      try {
        await client.send(new DeleteWorkloadIdentityCommand({ name }));
        logger.info('Deleted workload identity', { name });
      } catch (err) {
        // Already gone (or never created) — deletion is idempotent from CFN's view.
        if (err instanceof ResourceNotFoundException) {
          logger.info('Workload identity already absent on delete', { name });
        } else {
          throw err;
        }
      }
      return { PhysicalResourceId: event.PhysicalResourceId ?? name };
    }
  }
}

/** Exported for tests: probe whether a workload identity exists. */
export async function workloadIdentityExists(name: string): Promise<boolean> {
  try {
    await client.send(new GetWorkloadIdentityCommand({ name }));
    return true;
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return false;
    throw err;
  }
}
