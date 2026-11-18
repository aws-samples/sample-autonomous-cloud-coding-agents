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

import { PassThrough } from 'stream';
import { PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ApiClient } from '../../src/api-client';
import { makeSlackCommand, resolveSlackTeamId } from '../../src/commands/slack';
import * as config from '../../src/config';
import * as promptSecretMod from '../../src/prompt-secret';

jest.mock('../../src/api-client');

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: ddbSend })),
    },
  };
});

const ddbSend = jest.fn();

// CloudFormation — `setup` reads the app manifest and the three secret ARNs from stack outputs.
const cfnSend = jest.fn();
jest.mock('@aws-sdk/client-cloudformation', () => ({
  ...jest.requireActual('@aws-sdk/client-cloudformation'),
  CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
}));

// Secrets Manager — `setup` stores the three credentials.
const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  ...jest.requireActual('@aws-sdk/client-secrets-manager'),
  SecretsManagerClient: jest.fn(() => ({ send: smSend })),
}));

describe('slack command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockSlackLink = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockSlackLink.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: jest.fn(),
      cancelTask: jest.fn(),
      getTaskEvents: jest.fn(),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
      slackLink: mockSlackLink,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('slack link', () => {
    const linkResponse = {
      slack_team_id: 'T0123ABC',
      slack_user_id: 'U0456DEF',
      linked_at: '2026-04-14T12:00:00Z',
    };

    test('links a Slack account with a verification code', async () => {
      mockSlackLink.mockResolvedValue(linkResponse);

      const cmd = makeSlackCommand();
      await cmd.parseAsync(['node', 'test', 'link', 'A1B2C3']);

      expect(mockSlackLink).toHaveBeenCalledWith('A1B2C3');
      const calls = consoleSpy.mock.calls.map(c => c[0]) as string[];
      expect(calls.some(c => c.includes('linked successfully'))).toBe(true);
      expect(calls.some(c => c.includes('T0123ABC'))).toBe(true);
      expect(calls.some(c => c.includes('U0456DEF'))).toBe(true);
    });

    test('outputs JSON when --output json', async () => {
      mockSlackLink.mockResolvedValue(linkResponse);

      const cmd = makeSlackCommand();
      await cmd.parseAsync(['node', 'test', 'link', 'A1B2C3', '--output', 'json']);

      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(linkResponse, null, 2));
    });

    test('passes the code argument to the API client', async () => {
      mockSlackLink.mockResolvedValue(linkResponse);

      const cmd = makeSlackCommand();
      await cmd.parseAsync(['node', 'test', 'link', 'XYZ789']);

      expect(mockSlackLink).toHaveBeenCalledWith('XYZ789');
    });
  });

  describe('resolveSlackTeamId', () => {
    let exitSpy: jest.SpiedFunction<typeof process.exit>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;

    beforeEach(() => {
      ddbSend.mockReset();
      errorSpy = jest.spyOn(console, 'error').mockImplementation();
      // Make process.exit throw so the function stops like it would in the CLI,
      // and the test can assert it was reached.
      exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit:${code}`);
      }) as never);
    });

    afterEach(() => {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    test('prefers an explicit --team-id without touching DynamoDB', async () => {
      const teamId = await resolveSlackTeamId('us-east-1', 'SlackInstall', 'T-EXPLICIT');
      expect(teamId).toBe('T-EXPLICIT');
      expect(ddbSend).not.toHaveBeenCalled();
    });

    test('auto-resolves the single active installation', async () => {
      ddbSend.mockResolvedValueOnce({ Items: [{ team_id: 'T-ONLY', status: 'active' }] });
      const teamId = await resolveSlackTeamId('us-east-1', 'SlackInstall', undefined);
      expect(teamId).toBe('T-ONLY');
    });

    test('exits asking for --team-id when multiple installations exist', async () => {
      ddbSend.mockResolvedValueOnce({
        Items: [
          { team_id: 'T-A', status: 'active' },
          { team_id: 'T-B', status: 'active' },
        ],
      });
      await expect(resolveSlackTeamId('us-east-1', 'SlackInstall', undefined)).rejects.toThrow('process.exit');
      const msgs = errorSpy.mock.calls.map(c => String(c[0]));
      expect(msgs.some(m => m.includes('Multiple Slack workspaces'))).toBe(true);
    });

    test('exits when no active installations exist', async () => {
      ddbSend.mockResolvedValueOnce({ Items: [] });
      await expect(resolveSlackTeamId('us-east-1', 'SlackInstall', undefined)).rejects.toThrow('process.exit');
    });

    test('exits when the installation table name is unavailable', async () => {
      await expect(resolveSlackTeamId('us-east-1', null, undefined)).rejects.toThrow('process.exit');
      expect(ddbSend).not.toHaveBeenCalled();
    });
  });

  describe('slack setup', () => {
    const SIGNING_SECRET = 'a'.repeat(32);
    const CLIENT_SECRET = 'b'.repeat(32);
    let loadConfigSpy: jest.SpiedFunction<typeof config.loadConfig>;
    let promptSecretSpy: jest.SpiedFunction<typeof promptSecretMod.promptSecret>;
    let errorSpy: jest.SpiedFunction<typeof console.error>;

    beforeEach(() => {
      cfnSend.mockReset().mockResolvedValue({
        Stacks: [{
          Outputs: [
            { OutputKey: 'SlackAppManifestJson', OutputValue: '{"oauth_config":{"redirect_urls":["https://api.example.test/v1/slack/oauth/callback"]}}' },
            { OutputKey: 'SlackSigningSecretArn', OutputValue: 'arn:signing-secret' },
            { OutputKey: 'SlackClientSecretArn', OutputValue: 'arn:client-secret' },
            { OutputKey: 'SlackClientIdSecretArn', OutputValue: 'arn:client-id' },
          ],
        }],
      });
      smSend.mockReset().mockResolvedValue({});
      loadConfigSpy = jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-west-2' } as ReturnType<typeof config.loadConfig>);
      promptSecretSpy = jest.spyOn(promptSecretMod, 'promptSecret');
      errorSpy = jest.spyOn(console, 'error').mockImplementation();
    });

    afterEach(() => {
      loadConfigSpy.mockRestore();
      promptSecretSpy.mockRestore();
      errorSpy.mockRestore();
    });

    const runSetup = () => makeSlackCommand().parseAsync(['node', 'test', 'setup']);
    const stored = () => smSend.mock.calls.map(([command]) => (command as PutSecretValueCommand).input);
    const printed = () => consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');

    describe('with the Client ID read from a pipe', () => {
      // The two secrets come from the hidden prompt, replaced here; the Client ID is not a
      // secret and comes from the visible prompt, which reads the real stdin of the test.
      let stdin: PassThrough;
      let restore: () => void;

      beforeEach(() => {
        promptSecretSpy.mockResolvedValueOnce(SIGNING_SECRET).mockResolvedValueOnce(CLIENT_SECRET);
        stdin = new PassThrough();
        const original = Object.getOwnPropertyDescriptor(process, 'stdin');
        Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        restore = () => {
          stderrSpy.mockRestore();
          if (original) Object.defineProperty(process, 'stdin', original);
        };
      });

      afterEach(() => restore());

      test('stores the three credentials and builds the install link from the Client ID', async () => {
        stdin.end('  12345.67890  \n');

        await runSetup();

        expect(stored()).toEqual([
          { SecretId: 'arn:signing-secret', SecretString: SIGNING_SECRET },
          { SecretId: 'arn:client-secret', SecretString: CLIENT_SECRET },
          { SecretId: 'arn:client-id', SecretString: '12345.67890' },
        ]);
        expect(printed()).toContain('https://slack.com/oauth/v2/authorize?client_id=12345.67890&');
      });

      test('fails, and stores nothing, when the input ends before the Client ID', async () => {
        // The prompt this command had never answered at the end of the input: node then ran
        // out of work and exited with code 0, as if the credentials had been stored.
        stdin.end();

        await expect(runSetup()).rejects.toThrow('No input provided.');
        expect(smSend).not.toHaveBeenCalled();
      });
    });

    test('asks again until all three values look like Slack credentials', async () => {
      const promptLineSpy = jest.spyOn(promptSecretMod, 'promptLine');
      // Round 1: a value is missing. Round 2: none has the right form. Round 3: all good.
      promptSecretSpy
        .mockResolvedValueOnce('').mockResolvedValueOnce(CLIENT_SECRET)
        .mockResolvedValueOnce('not-hex').mockResolvedValueOnce('too-short')
        .mockResolvedValueOnce(SIGNING_SECRET).mockResolvedValueOnce(CLIENT_SECRET);
      promptLineSpy
        .mockResolvedValueOnce('12345.67890')
        .mockResolvedValueOnce('A0123456789')
        .mockResolvedValueOnce('12345.67890');
      try {
        await runSetup();

        expect(promptLineSpy).toHaveBeenCalledTimes(3);
        expect(promptLineSpy).toHaveBeenCalledWith('Client ID');
        const errors = errorSpy.mock.calls.map((c) => String(c[0]));
        expect(errors).toEqual([
          '\n✗ All three values are required. Try again.\n',
          '\n✗ Signing Secret must be 32 hex characters.',
          '✗ Client Secret must be 32 hex characters.',
          '✗ Client ID should be numeric (e.g. 12345.67890).',
          '\nCheck Basic Information → App Credentials and try again.\n',
        ]);
        // Only the round that passed the checks is stored.
        expect(stored().map((s) => s.SecretString)).toEqual([SIGNING_SECRET, CLIENT_SECRET, '12345.67890']);
      } finally {
        promptLineSpy.mockRestore();
      }
    });
  });
});
