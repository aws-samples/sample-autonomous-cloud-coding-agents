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

// Latch and announce a revoked Linear authorization (#812).
//
// Until this existed the platform detected revocation perfectly and then did
// nothing with it: the operator found out because a user's task silently failed,
// and every later event re-detected the same dead grant with no dedup.
//
// TWO PROPERTIES THIS FILE EXISTS TO GUARANTEE.
//
// 1. ANNOUNCE ONCE. A revoked workspace keeps receiving events, so alerting on
//    detection would page per event. The registry latch is the dedup key: only the
//    caller whose conditional write actually flipped `active → revoked` announces.
//
// 2. DO NOT ANNOUNCE THROUGH THE BROKEN CHANNEL. The dead credential is Linear's
//    own, so a Linear comment cannot report it — that is precisely the path that no
//    longer works. Notification goes to SNS (operator email/Slack subscription),
//    which has an independent credential and therefore still works when Linear
//    does not.
//
// Everything here is best-effort: recording or announcing a diagnosis must never
// turn a feedback outage into a thrown handler.
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { markWorkspaceRevoked, type RevocationDetail } from './linear-oauth-resolver';
import { logger } from './logger';
import { makeClient } from './ua';

/** Why the grant is dead, in words an operator can act on. */
const SOURCE_EXPLANATION: Record<RevocationDetail['source'], string> = {
  'secrets-manager-refresh':
    'Linear rejected the stored refresh token, so the saved authorization can no longer be renewed.',
  'vault-consent-required':
    'The AgentCore Identity vault reports that this workspace needs a fresh consent, and no '
    + 'Secrets Manager fallback token is usable.',
};

export interface RevocationAlertConfig {
  readonly ddb: DynamoDBDocumentClient;
  readonly registryTableName: string;
  /** SNS topic for operator notification. Absent ⇒ latch only, no announcement. */
  readonly alertTopicArn?: string;
  readonly region?: string;
  /** Override for tests. */
  readonly snsClient?: SNSClient;
}

/**
 * Build the `onAuthorizationRevoked` handler for the token resolver.
 *
 * Returns a function that latches the registry row and, only if that latch
 * applied, publishes one operator notification.
 */
export function makeRevocationAlerter(
  config: RevocationAlertConfig,
): (detail: RevocationDetail) => Promise<void> {
  return async (detail: RevocationDetail): Promise<void> => {
    const latched = await markWorkspaceRevoked(
      config.ddb,
      config.registryTableName,
      detail.linearWorkspaceId,
      detail.installedAt,
      undefined,
      detail.source === 'vault-consent-required' ? 'vault_consent_required' : 'refresh_token_rejected',
    );

    if (!latched) {
      // Already revoked, or the row has moved on to a NEWER installation than the
      // one this verdict describes. Either way there is nothing new to announce.
      logger.info('Revocation already recorded — not announcing again', {
        linear_workspace_id: detail.linearWorkspaceId,
        source: detail.source,
      });
      return;
    }

    if (!config.alertTopicArn) {
      logger.warn('Linear authorization revoked, but no alert topic is configured — recorded only', {
        linear_workspace_id: detail.linearWorkspaceId,
        source: detail.source,
      });
      return;
    }

    const slug = detail.workspaceSlug ?? detail.linearWorkspaceId;
    const subject = `ABCA: Linear workspace '${slug}' needs re-authorization`;
    const message = [
      `The Linear authorization for workspace '${slug}' is no longer usable.`,
      '',
      SOURCE_EXPLANATION[detail.source],
      '',
      'Until it is re-authorized, Linear-triggered tasks for this workspace are dropped:',
      'applying the trigger label will appear to do nothing.',
      '',
      'To fix it, run:',
      `  bgagent linear setup ${slug}`,
      detail.source === 'vault-consent-required'
        ? `  bgagent linear vault-setup ${slug}    (to restore the Token Vault path)`
        : '',
      '',
      `Workspace id: ${detail.linearWorkspaceId}`,
      `Detected by:  ${detail.source}`,
    ].filter((line) => line !== '').join('\n');

    try {
      const sns = config.snsClient
        ?? makeClient(SNSClient, { region: config.region ?? process.env.AWS_REGION ?? 'us-east-1' });
      await sns.send(new PublishCommand({
        TopicArn: config.alertTopicArn,
        Subject: subject.slice(0, 100), // SNS caps Subject at 100 chars.
        Message: message,
      }));
      logger.warn('Announced revoked Linear authorization to the operational alert topic', {
        linear_workspace_id: detail.linearWorkspaceId,
        workspace_slug: detail.workspaceSlug,
        source: detail.source,
      });
    } catch (err) {
      // The latch already landed, so the state is discoverable via `platform
      // doctor` even though this announcement failed. Never rethrow: a failed
      // notification must not escalate into a broken handler.
      logger.error('Could not announce the revoked Linear authorization (recorded, but not notified)', {
        linear_workspace_id: detail.linearWorkspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}

/**
 * Convenience wiring for a handler that already has a doc client and reads its
 * configuration from the environment. Returns undefined when the registry table is
 * not configured, so callers can pass the result straight through as
 * `onAuthorizationRevoked` and get today's behaviour (no latch, no alert) on a
 * stack that has not wired it.
 */
export function revocationAlerterFromEnv(
  ddb: DynamoDBDocumentClient,
  registryTableName: string | undefined,
): ((detail: RevocationDetail) => Promise<void>) | undefined {
  if (!registryTableName) return undefined;
  const alertTopicArn = process.env.OPERATIONAL_ALERT_TOPIC_ARN;
  return makeRevocationAlerter({
    ddb,
    registryTableName,
    ...(alertTopicArn && { alertTopicArn }),
  });
}
