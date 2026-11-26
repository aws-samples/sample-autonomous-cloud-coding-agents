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

import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { logger } from './logger';
import { makeClient } from './ua';

export interface AnnounceableRevocation {
  readonly linearWorkspaceId: string;
  readonly workspaceSlug?: string;
  readonly source: 'secrets-manager-refresh' | 'vault-consent-required';
}

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
 * Never throws. Returns whether the publish landed.
 */
export async function announceRevocation(
  detail: AnnounceableRevocation,
  opts: { readonly topicArn: string; readonly region?: string; readonly snsClient?: SNSClient },
): Promise<boolean> {
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
    detail.source === 'vault-consent-required'
      ? `  bgagent linear setup ${slug}    (re-consents; restores the Token Vault path)`
      : `  bgagent linear setup ${slug}`,
    '',
    `Workspace id: ${detail.linearWorkspaceId}`,
    `Detected by:  ${detail.source}`,
  ].join('\n');

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
    return true;
  } catch (err) {
    logger.error('Could not announce the revoked Linear authorization (recorded, but not notified)', {
      linear_workspace_id: detail.linearWorkspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
