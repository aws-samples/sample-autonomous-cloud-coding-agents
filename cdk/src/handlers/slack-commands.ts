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

import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './shared/logger';
import { getSlackSecret, verifySlackSignature } from './shared/slack-verify';

const lambdaClient = new LambdaClient({});

const SIGNING_SECRET_ARN = process.env.SLACK_SIGNING_SECRET_ARN!;
const PROCESSOR_FUNCTION_NAME = process.env.SLACK_COMMAND_PROCESSOR_FUNCTION_NAME!;

/** Parsed Slack slash command payload (URL-encoded form data). */
export interface SlackCommandPayload {
  readonly command: string;
  readonly text: string;
  readonly response_url: string;
  readonly trigger_id: string;
  readonly user_id: string;
  readonly user_name: string;
  readonly team_id: string;
  readonly team_domain: string;
  readonly channel_id: string;
  readonly channel_name: string;
}

/**
 * POST /v1/slack/commands — Handle Slack slash commands.
 *
 * Must respond within 3 seconds. Verifies the signing secret, parses the
 * command, acknowledges immediately, and async-invokes the processor Lambda.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    if (!event.body) {
      return slackResponse('Request body is required.');
    }

    // Verify Slack signing secret.
    const signingSecret = await getSlackSecret(SIGNING_SECRET_ARN);
    if (!signingSecret) {
      logger.error('Slack signing secret not found');
      return slackResponse('Internal configuration error.');
    }

    const signature = event.headers['X-Slack-Signature'] ?? event.headers['x-slack-signature'] ?? '';
    const timestamp = event.headers['X-Slack-Request-Timestamp'] ?? event.headers['x-slack-request-timestamp'] ?? '';

    if (!verifySlackSignature(signingSecret, signature, timestamp, event.body)) {
      logger.warn('Invalid Slack command signature');
      return { statusCode: 401, headers: { 'Content-Type': 'text/plain' }, body: 'Invalid signature' };
    }

    // Parse URL-encoded form body.
    const payload = parseFormBody(event.body);
    const subcommand = (payload.text ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';

    // For 'help' we can respond inline (no async processing needed).
    if (subcommand === 'help' || subcommand === '') {
      return slackResponse(HELP_TEXT);
    }

    // Async-invoke the processor Lambda for all other subcommands.
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: PROCESSOR_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify(payload)),
      }));
    } catch (err) {
      logger.error('Failed to invoke Slack command processor', {
        error: err instanceof Error ? err.message : String(err),
        subcommand,
      });
      return slackResponse('Failed to process command. Please try again.');
    }

    // Acknowledge immediately — the processor will follow up via response_url.
    const ackMessage = ACK_MESSAGES[subcommand] ?? `Processing \`${subcommand}\`...`;
    return slackResponse(ackMessage);
  } catch (err) {
    logger.error('Slack command handler failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return slackResponse('An unexpected error occurred. Please try again.');
  }
}

function parseFormBody(body: string): SlackCommandPayload {
  const params = new URLSearchParams(body);
  return {
    command: params.get('command') ?? '',
    text: params.get('text') ?? '',
    response_url: params.get('response_url') ?? '',
    trigger_id: params.get('trigger_id') ?? '',
    user_id: params.get('user_id') ?? '',
    user_name: params.get('user_name') ?? '',
    team_id: params.get('team_id') ?? '',
    team_domain: params.get('team_domain') ?? '',
    channel_id: params.get('channel_id') ?? '',
    channel_name: params.get('channel_name') ?? '',
  };
}

function slackResponse(text: string): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ response_type: 'ephemeral', text }),
  };
}

const ACK_MESSAGES: Record<string, string> = {
  link: ':link: Generating link code...',
};

const HELP_TEXT = `*Using Shoof*

*Submit a task:* Mention \`@Shoof\` in any channel:
> \`@Shoof fix the login bug in org/repo#42\`
> \`@Shoof update the README in org/repo\`

*Private submissions:* DM Shoof directly.

*Cancel a task:* Use the Cancel button in the thread.

*Link your account:* \`/bgagent link\` — one-time setup.

Reactions on your message show progress: :eyes: → :hourglass_flowing_sand: → :white_check_mark:`;
