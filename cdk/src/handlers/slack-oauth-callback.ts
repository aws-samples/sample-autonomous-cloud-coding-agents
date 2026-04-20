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

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateSecretCommand, RestoreSecretCommand, SecretsManagerClient, UpdateSecretCommand, ResourceNotFoundException, InvalidRequestException } from '@aws-sdk/client-secrets-manager';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { logger } from './shared/logger';
import { getSlackSecret, SLACK_SECRET_PREFIX } from './shared/slack-verify';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sm = new SecretsManagerClient({});

const TABLE_NAME = process.env.SLACK_INSTALLATION_TABLE_NAME!;
const CLIENT_ID_SECRET_ARN = process.env.SLACK_CLIENT_ID_SECRET_ARN!;
const CLIENT_SECRET_ARN = process.env.SLACK_CLIENT_SECRET_ARN!;

interface SlackOAuthResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly app_id?: string;
  readonly team?: { readonly id: string; readonly name: string };
  readonly bot_user_id?: string;
  readonly access_token?: string;
  readonly scope?: string;
  readonly authed_user?: { readonly id: string };
}

/**
 * GET /v1/slack/oauth/callback — Handle Slack OAuth V2 redirect.
 *
 * After a workspace admin authorizes the Slack App, Slack redirects here
 * with a `code` query parameter. This handler exchanges the code for a
 * bot token, stores it in Secrets Manager, and records the installation.
 */
export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const code = event.queryStringParameters?.code;
    if (!code) {
      return htmlResponse(400, 'Missing authorization code. Please try the install flow again.');
    }

    // Fetch the Slack App client ID and client secret from Secrets Manager.
    const clientId = await getSlackSecret(CLIENT_ID_SECRET_ARN);
    if (!clientId) {
      logger.error('Slack client ID not found', { secret_arn: CLIENT_ID_SECRET_ARN });
      return htmlResponse(500, 'Slack client ID not configured. Populate the secret in Secrets Manager.');
    }

    const clientSecret = await getSlackSecret(CLIENT_SECRET_ARN);
    if (!clientSecret) {
      logger.error('Slack client secret not found', { secret_arn: CLIENT_SECRET_ARN });
      return htmlResponse(500, 'Slack client secret not configured. Populate the secret in Secrets Manager.');
    }

    // Exchange the code for an access token.
    const redirectUri = buildRedirectUri(event);
    const tokenResponse = await exchangeCode(code, clientId, clientSecret, redirectUri);
    if (!tokenResponse.ok || !tokenResponse.access_token || !tokenResponse.team) {
      logger.error('Slack OAuth token exchange failed', {
        error: tokenResponse.error ?? 'unknown',
      });
      return htmlResponse(400, `Slack authorization failed: ${tokenResponse.error ?? 'unknown error'}`);
    }

    const teamId = tokenResponse.team.id;
    const teamName = tokenResponse.team.name;
    const botToken = tokenResponse.access_token;
    const now = new Date().toISOString();

    // Store the bot token in Secrets Manager.
    const secretName = `${SLACK_SECRET_PREFIX}${teamId}`;
    await upsertSecret(secretName, botToken, teamId);

    // Write installation record to DynamoDB.
    await ddb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        team_id: teamId,
        team_name: teamName,
        bot_token_secret_arn: secretName,
        bot_user_id: tokenResponse.bot_user_id ?? '',
        app_id: tokenResponse.app_id ?? '',
        scope: tokenResponse.scope ?? '',
        installed_by: tokenResponse.authed_user?.id ?? '',
        installed_at: now,
        updated_at: now,
        status: 'active',
      },
    }));

    logger.info('Slack workspace installed', { team_id: teamId, team_name: teamName });

    return htmlResponse(200, `
      <h2>Successfully installed!</h2>
      <p>ABCA Background Agent has been added to the <strong>${escapeHtml(teamName)}</strong> workspace.</p>
      <p>Team members can now link their accounts with <code>/bgagent link</code> and start submitting tasks.</p>
    `);
  } catch (err) {
    logger.error('Slack OAuth callback failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return htmlResponse(500, 'An unexpected error occurred. Please try again.');
  }
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<SlackOAuthResponse> {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  const response = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  return await response.json() as SlackOAuthResponse;
}

async function upsertSecret(secretName: string, secretValue: string, teamId: string): Promise<void> {
  try {
    await sm.send(new UpdateSecretCommand({
      SecretId: secretName,
      SecretString: secretValue,
    }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      await sm.send(new CreateSecretCommand({
        Name: secretName,
        SecretString: secretValue,
        Description: `Slack bot token for workspace ${teamId}`,
        Tags: [
          { Key: 'team_id', Value: teamId },
          { Key: 'service', Value: 'bgagent-slack' },
        ],
      }));
    } else if (err instanceof InvalidRequestException && String(err.message).includes('marked for deletion')) {
      // Secret was scheduled for deletion during app uninstall — restore it and update.
      await sm.send(new RestoreSecretCommand({ SecretId: secretName }));
      await sm.send(new UpdateSecretCommand({
        SecretId: secretName,
        SecretString: secretValue,
      }));
    } else {
      throw err;
    }
  }
}

function buildRedirectUri(event: APIGatewayProxyEvent): string {
  const host = event.headers.Host ?? event.headers.host ?? '';
  const stage = event.requestContext.stage ?? '';
  return `https://${host}/${stage}/slack/oauth/callback`;
}

function htmlResponse(statusCode: number, body: string): APIGatewayProxyResult {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>ABCA Slack Integration</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;padding:0 20px;color:#333}</style>
</head><body>${body}</body></html>`;
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: html,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
