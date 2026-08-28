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
import { logger } from './logger';
import { makeClient } from './ua';

/**
 * Mirrors `RevocationDetail` from the resolver, declared locally ON PURPOSE: the
 * resolver owns the latch and calls into this module, so importing its types here
 * would create a cycle (resolver → alert → resolver).
 */
export interface AnnounceableRevocation {
  readonly linearWorkspaceId: string;
  readonly workspaceSlug?: string;
  readonly source: 'secrets-manager-refresh' | 'vault-consent-required';
}

/** Why the grant is dead, in words an operator can act on. */
const SOURCE_EXPLANATION: Record<AnnounceableRevocation['source'], string> = {
  'secrets-manager-refresh':
    'Linear rejected the stored refresh token, so the saved authorization can no longer be renewed.',
  'vault-consent-required':
    'The AgentCore Identity vault reports that this workspace needs a fresh consent, and no '
    + 'Secrets Manager fallback token is usable.',
};

/** The operator alert topic, or undefined when the stack has not wired one. */
export function revocationAlertTopicArn(): string | undefined {
  return process.env.OPERATIONAL_ALERT_TOPIC_ARN || undefined;
}

/**
 * Announce ONE revoked authorization to the operator.
 *
 * Call this only after the registry latch actually applied — that conditional
 * write is the dedup key. A revoked workspace keeps producing events, so
 * announcing on detection instead of on latch would page once per event.
 *
 * Never throws. The latch has already landed by the time this runs, so the state
 * is discoverable via `bgagent platform doctor` even if the notification fails, and
 * this executes inside token resolution where an exception would turn a
 * notification outage into a broken webhook handler.
 */
export async function announceRevocation(
  detail: AnnounceableRevocation,
  opts: { readonly topicArn: string; readonly region?: string; readonly snsClient?: SNSClient },
): Promise<void> {
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
    const sns = opts.snsClient
      ?? makeClient(SNSClient, { region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1' });
    await sns.send(new PublishCommand({
      TopicArn: opts.topicArn,
      Subject: subject.slice(0, 100), // SNS caps Subject at 100 chars.
      Message: message,
    }));
    logger.warn('Announced revoked Linear authorization to the operational alert topic', {
      linear_workspace_id: detail.linearWorkspaceId,
      workspace_slug: detail.workspaceSlug,
      source: detail.source,
    });
  } catch (err) {
    logger.error('Could not announce the revoked Linear authorization (recorded, but not notified)', {
      linear_workspace_id: detail.linearWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
