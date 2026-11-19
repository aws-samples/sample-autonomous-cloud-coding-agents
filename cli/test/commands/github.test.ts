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

import { GetSecretValueCommand, PutSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { makeGithubCommand } from '../../src/commands/github';
import { promptSecret } from '../../src/prompt-secret';
import { getStackOutput } from '../../src/stack-outputs';

const smSend = jest.fn();
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const actual = jest.requireActual('@aws-sdk/client-secrets-manager');
  return { ...actual, SecretsManagerClient: jest.fn(() => ({ send: smSend })) };
});
jest.mock('../../src/stack-outputs', () => ({ getStackOutput: jest.fn() }));
jest.mock('../../src/prompt-secret', () => ({ promptSecret: jest.fn() }));
jest.mock('../../src/config', () => ({
  loadConfig: () => ({ region: 'us-east-1' }),
  tryLoadConfig: () => null,
}));

/**
 * What a deployed stack holds in a secret nobody has set: CDK creates it with
 * CloudFormation's generated password (32 characters, at least one upper-case
 * letter, lower-case letter, digit and punctuation character).
 */
const GENERATED_PASSWORD = 'Aa1!'.repeat(8);

describe('github command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const output = (): string => consoleSpy.mock.calls.map((call) => String(call[0] ?? '')).join('\n');
  const run = (...args: string[]): Promise<unknown> =>
    makeGithubCommand().parseAsync(['node', 'github', ...args, '--region', 'us-east-1']);

  /** The secret currently holds `stored`; writes succeed. */
  function secretHolds(stored: string): void {
    smSend.mockImplementation(async (command: unknown) =>
      (command instanceof GetSecretValueCommand ? { SecretString: stored } : {}));
  }

  /** Every value the command wrote, in order. */
  const written = (): unknown[] => smSend.mock.calls
    .map((call) => call[0] as unknown)
    .filter((command): command is PutSecretValueCommand => command instanceof PutSecretValueCommand)
    .map((command) => command.input);

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    smSend.mockReset();
    (getStackOutput as jest.Mock).mockImplementation(async (_region: string, _stack: string, key: string) =>
      (key.endsWith('SecretArn') ? `arn:${key}` : null));
    (promptSecret as jest.Mock).mockResolvedValue('value-typed-by-the-operator');
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('set-token on a fresh stack stores the token without an overwrite warning', async () => {
    secretHolds(GENERATED_PASSWORD);

    await run('set-token');

    expect(output()).not.toContain('OVERWRITE');
    expect(written()).toEqual([{ SecretId: 'arn:GitHubTokenSecretArn', SecretString: 'value-typed-by-the-operator' }]);
  });

  test('set-token warns before replacing a stored token', async () => {
    // Built with repeat() so that no token-shaped literal sits in the source.
    secretHolds(`ghp_${'a1B2'.repeat(9)}`);

    await run('set-token');

    expect(output()).toContain('A GitHub token is already configured in this secret. This command will OVERWRITE it.');
  });

  test('set-webhook-secret does not claim a signing secret is configured on a fresh stack', async () => {
    secretHolds(GENERATED_PASSWORD);

    await run('set-webhook-secret');

    expect(output()).not.toContain('already configured');
    // What it says instead, whatever the secret holds.
    expect(output()).toContain('This replaces the signing secret stored for the stack.');
    expect(written()).toEqual([{ SecretId: 'arn:GitHubWebhookSecretArn', SecretString: 'value-typed-by-the-operator' }]);
  });
});
