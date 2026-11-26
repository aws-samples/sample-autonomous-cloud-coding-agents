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

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { AGENT_SESSION_EVENT_TYPE, isHandledAgentSessionAction, isLinearAgentSessionsEnabled } from './shared/linear-agent-session-event';
import {
  countActiveLinearWorkspaces,
  isWebhookTimestampFresh,
  verifyLinearRequest,
  verifyLinearRequestForWorkspace,
} from './shared/linear-verify';
import { logger } from './shared/logger';
import { dedupAndDispatch, jsonResponse } from './shared/webhook-dispatch';

const WEBHOOK_SECRET_ARN = process.env.LINEAR_WEBHOOK_SECRET_ARN!;
const DEDUP_TABLE_NAME = process.env.LINEAR_WEBHOOK_DEDUP_TABLE_NAME!;
const PROCESSOR_FUNCTION_NAME = process.env.LINEAR_WEBHOOK_PROCESSOR_FUNCTION_NAME!;
/** Optional. When unset, the per-workspace signing-secret path is skipped
 *  and only the stack-wide secret is consulted (back-compat for installs
 *  predating per-workspace secrets). */
const WORKSPACE_REGISTRY_TABLE = process.env.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME;

/**
 * Dedup window (seconds). Must exceed Linear's full retry horizon: first
 * retry is +1m, then +1h, then +6h (~7h total from the initial delivery).
 * A window shorter than this lets the +1h / +6h retries land after the
 * dedup row has TTL'd out, which would double-create the task when an
 * ack was lost. 8h is comfortably over the horizon with slack for clock
 * skew, without making stale rows live meaningfully longer (DDB TTL is
 * async best-effort anyway).
 */
const DEDUP_TTL_HOURS = 8;
const DEDUP_TTL_SECONDS = DEDUP_TTL_HOURS * 3600;

/**
 * Shape of the top-level Linear webhook payload we care about for dedup + routing.
 * Full payload is forwarded to the processor without re-serialization risk —
 * the processor parses its own copy from the raw body.
 */
interface LinearWebhookEnvelope {
  readonly action?: string;
  readonly type?: string;
  readonly webhookTimestamp?: number;
  readonly webhookId?: string;
  readonly organizationId?: string;
  readonly data?: {
    readonly id?: string;
    readonly [key: string]: unknown;
  };
  /** Present on `AgentSessionEvent` deliveries (agent-session channel). */
  readonly agentSession?: {
    readonly id?: string;
  };
}

/** Log a delivery the receiver acknowledges without forwarding. */
function logIgnoredWebhookType(
  payload: { type?: string; action?: string; organizationId?: string },
  agentSessionsEnabled: boolean,
): void {
  // Agent-session / app-notification events are the fingerprint of an
  // OAuth app configured as a Linear *agent* (agent-activity events turned
  // on). With the agent-session channel OFF, ABCA never consumes these,
  // AND when they're enabled Linear renders an @mention of the app as its
  // interactive agent-activity surface instead of a normal comment thread,
  // which breaks the maturing-reply/reaction UX. Surface this at WARN (not
  // a silent INFO ignore) so an operator can see "this workspace's app is
  // in agent mode" and either disable agent/app events or deploy with
  // `enableLinearAgentSessions=true`. See docs/guides for the config.
  const AGENT_MODE_TYPES = ['AppUserNotification', 'AgentSession', 'AgentSessionEvent', 'AgentActivity'];
  if (!agentSessionsEnabled && payload.type !== undefined && AGENT_MODE_TYPES.includes(payload.type)) {
    // Message text unchanged from before the agent-session channel existed —
    // operators' metric filters key on it. The remedy hint rides a field.
    logger.warn(
      'Ignoring Linear agent-mode webhook — the OAuth app appears configured as a Linear agent '
      + '(agent/app events enabled). ABCA uses plain comment threads; agent mode makes @mentions render '
      + 'as interactive agent activity instead of comments. Disable agent/app events on the Linear app '
      + '(keep only Issue + Comment webhook events).',
      {
        type: payload.type,
        action: payload.action,
        linear_workspace_id: payload.organizationId,
        alternative: 'deploy with --context enableLinearAgentSessions=true to answer agent sessions natively',
      },
    );
    return;
  }
  logger.info('Ignoring non-Issue/Comment Linear webhook', { type: payload.type, action: payload.action });
}

/**
 * POST /v1/linear/webhook — Linear webhook receiver.
 *
 * Verifies the `Linear-Signature` HMAC over the raw body, rejects stale
 * `webhookTimestamp` values (replay protection), dedups on
 * `(data.id, action, webhookTimestamp)` with an 8h TTL, and async-invokes the processor
 * Lambda so we can ack within Linear's 5s timeout.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return jsonResponse(400, { error: 'Request body is required' });
    }

    const signature = event.headers['Linear-Signature'] ?? event.headers['linear-signature'] ?? '';
    if (!signature) {
      logger.warn('Linear webhook missing Linear-Signature header');
      return jsonResponse(401, { error: 'Missing signature' });
    }

    // Parse body ONCE — we peek at the orgId before signature verification
    // so we can pick the right per-workspace signing secret. The orgId is
    // untrusted at this point; it only selects WHICH secret to verify
    // against. An attacker can claim any orgId but still needs the
    // matching signing secret to forge a valid signature.
    let payload: LinearWebhookEnvelope;
    try {
      payload = JSON.parse(event.body) as LinearWebhookEnvelope;
    } catch (err) {
      logger.warn('Linear webhook body is not valid JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return jsonResponse(400, { error: 'Invalid JSON' });
    }
    // `null` parses, but reading a field of it throws: answer as for unparseable JSON.
    if (payload === null) {
      return jsonResponse(400, { error: 'Invalid JSON' });
    }

    // Try the per-workspace secret first. Falls through to the stack-wide
    // path if (a) registry table not configured, (b) no orgId in body
    // (or one that is not a string: the registry key is a string, and
    // DynamoDB rejects a lookup by any other type),
    // (c) workspace not in registry, or (d) workspace's stored secret
    // lacks `webhook_signing_secret`. Per-workspace MISMATCH is fatal —
    // do NOT fall back, that would let an attacker bypass per-workspace
    // signatures by also matching the stack-wide one. REVOKED is also
    // fatal: a workspace that has been deactivated must not be able to
    // ride the stack-wide fallback (which `setup` mirrored from the
    // first workspace's signing secret) back into a verified state.
    let verified = false;
    if (WORKSPACE_REGISTRY_TABLE && typeof payload.organizationId === 'string' && payload.organizationId) {
      const result = await verifyLinearRequestForWorkspace(
        WORKSPACE_REGISTRY_TABLE,
        payload.organizationId,
        signature,
        event.body,
      );
      if (result === 'verified') {
        verified = true;
      } else if (result === 'mismatch') {
        logger.warn('Linear webhook signature mismatch against per-workspace secret', {
          linear_workspace_id: payload.organizationId,
        });
        return jsonResponse(401, { error: 'Invalid signature' });
      } else if (result === 'revoked') {
        logger.warn('Linear webhook from revoked workspace — rejecting without stack-wide fallback', {
          linear_workspace_id: payload.organizationId,
        });
        return jsonResponse(401, { error: 'Workspace not active' });
      } else if (result === 'shared-secret') {
        // The signature matched, but against a secret this workspace shares with
        // another on the same stack — so it proves the sender knows SOME tenant's
        // secret, not this one's. Fatal for the same reason `mismatch` is: falling
        // through would re-admit it via the stack-wide path.
        logger.warn('Linear webhook verified against a secret shared with another workspace — rejecting', {
          linear_workspace_id: payload.organizationId,
          remedy: 'bgagent linear update-webhook-secret <slug>',
        });
        return jsonResponse(401, { error: 'Workspace signing secret is not its own' });
      }
      // 'no-per-workspace-secret' falls through to the stack-wide path
      // below — back-compat for installs predating per-workspace secrets.
    }

    // Whether the stack-wide secret was what verified this delivery. Forwarded to the
    // processor, which routes from body-supplied identifiers that a tenant-less secret
    // cannot attest to.
    let verifiedViaStackWide = false;

    if (!verified) {
      // The stack-wide secret is bound to no workspace, so on a stack with more than one
      // it cannot say which tenant sent this — and the body's `organizationId` is the
      // attacker's to choose. Refuse rather than guess. Single-workspace installs keep
      // the fallback: there, the only tenant it could mean is the only tenant there is.
      const activeWorkspaces = await countActiveLinearWorkspaces(WORKSPACE_REGISTRY_TABLE);
      if (activeWorkspaces > 1) {
        logger.warn('Refusing the stack-wide fallback on a multi-workspace stack', {
          linear_workspace_id: payload.organizationId,
          active_workspace_count: activeWorkspaces,
          remedy: 'bgagent linear update-webhook-secret <slug>',
        });
        return jsonResponse(401, { error: 'Per-workspace signing secret required' });
      }

      if (!await verifyLinearRequest(WEBHOOK_SECRET_ARN, signature, event.body)) {
        logger.warn('Invalid Linear webhook signature', {
          linear_workspace_id: payload.organizationId,
        });
        return jsonResponse(401, { error: 'Invalid signature' });
      }
      verifiedViaStackWide = true;
      // Stack-wide fallback succeeded. Log positively so operators
      // diagnosing a per-workspace verification regression have a
      // breadcrumb that says "this workspace is verifying via the
      // back-compat path" rather than its own per-workspace secret.
      logger.info('Linear webhook verified via stack-wide fallback secret', {
        linear_workspace_id: payload.organizationId,
        per_workspace_registry_configured: Boolean(WORKSPACE_REGISTRY_TABLE),
      });
    }

    if (!isWebhookTimestampFresh(payload.webhookTimestamp)) {
      logger.warn('Linear webhook timestamp outside replay window', {
        webhook_timestamp: payload.webhookTimestamp,
        webhook_id: payload.webhookId,
      });
      return jsonResponse(401, { error: 'Stale webhook timestamp' });
    }

    // Issue events drive task creation; Comment events drive the comment
    // trigger (an @bgagent mention on a sub-issue re-iterates its PR). With the
    // agent-session flag on, AgentSessionEvent `created`/`prompted` deliveries
    // drive the native Linear agent channel (ADR-018 Phase 2). Every other type
    // is acknowledged silently so Linear stops retrying.
    const agentSessionsEnabled = isLinearAgentSessionsEnabled();
    const isAgentSessionDelivery = agentSessionsEnabled && payload.type === AGENT_SESSION_EVENT_TYPE;
    if (payload.type !== 'Issue' && payload.type !== 'Comment' && !isAgentSessionDelivery) {
      logIgnoredWebhookType(payload, agentSessionsEnabled);
      return jsonResponse(200, { ok: true });
    }

    // data.id is the issue id (Issue events) or the comment id (Comment
    // events); agent-session deliveries carry the session id instead.
    const { id: dataId, missingMessage } = isAgentSessionDelivery
      ? { id: payload.agentSession?.id, missingMessage: 'Linear webhook missing agentSession.id' }
      : { id: payload.data?.id, missingMessage: 'Linear webhook missing data.id' };
    const action = payload.action ?? 'unknown';
    if (!dataId) {
      logger.warn(missingMessage, { type: payload.type, action });
      return jsonResponse(400, { error: 'Missing data id' });
    }
    if (isAgentSessionDelivery && !isHandledAgentSessionAction(action)) {
      logger.info('Ignoring unhandled AgentSessionEvent action', { action });
      return jsonResponse(200, { ok: true });
    }
    // Comment events: only forward creates (an edited/removed comment must not
    // re-fire the agent). Issue events keep their existing create/update gate
    // downstream in the processor.
    if (payload.type === 'Comment' && action !== 'create') {
      logger.info('Ignoring non-create Comment webhook', { action });
      return jsonResponse(200, { ok: true });
    }
    const issueId = dataId;

    // Dedup via conditional PutItem.
    //
    // Linear's `webhookId` in the payload body is the *webhook configuration*
    // ID — reused on every delivery, not per-delivery. `webhookTimestamp`
    // (UNIX ms) is unique per delivery; Linear reuses it for retries of a
    // single delivery. Compose `${issueId}#${action}#${webhookTimestamp}` so
    // retries of the same event collapse (same timestamp) while distinct
    // events do not. A missing timestamp would have already failed the replay
    // check above, so treat its presence as a precondition.
    const dedupKey = `${issueId}#${action}#${payload.webhookTimestamp}`;
    return await dedupAndDispatch({
      label: 'Linear',
      dedupTableName: DEDUP_TABLE_NAME,
      dedupKey,
      ttlSeconds: DEDUP_TTL_SECONDS,
      processorFunctionName: PROCESSOR_FUNCTION_NAME,
      // The verified context travels with the body. Without it the processor cannot
      // tell a delivery whose tenant the signature attested from one whose tenant is
      // only claimed, and it routes from that claim.
      payload: { raw_body: event.body, verified_via_stack_wide: verifiedViaStackWide },
      logFields: { issue_id: issueId, action, webhook_id: payload.webhookId },
    });
  } catch (err) {
    logger.error('Linear webhook handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse(500, { error: 'Internal server error' });
  }
}
