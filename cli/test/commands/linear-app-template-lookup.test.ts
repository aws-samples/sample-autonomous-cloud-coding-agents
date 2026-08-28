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

/**
 * `bgagent linear app-template` looks its callback URLs up instead of asking the
 * operator to paste in a CloudFormation output and an AgentCore-minted callback id.
 *
 * It is the FIRST command in onboarding, which sets the bar for these tests: it
 * must still render when the CLI is unconfigured, credentials are absent, the
 * stack is not deployed, and the credential provider does not exist. A lookup that
 * throws would make the command that explains onboarding the one thing that cannot
 * run before onboarding.
 */

import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { resolveTemplateCallbackUrls } from '../../src/commands/linear';
import * as config from '../../src/config';
import * as linearVault from '../../src/linear-vault';

const cfnSend = jest.fn();

jest.mock('@aws-sdk/client-cloudformation', () => {
  const actual = jest.requireActual('@aws-sdk/client-cloudformation');
  return {
    ...actual,
    CloudFormationClient: jest.fn(() => ({ send: cfnSend })),
  };
});
jest.mock('../../src/linear-vault');

const lookupVaultCallback = jest.mocked(linearVault.lookupLinearVaultCallbackUrl);

const HOSTED = 'https://d2ud1woydykuxp.cloudfront.net/';
const VAULT = 'https://bedrock-agentcore.us-east-1.amazonaws.com/identities/oauth2/callback/f8804c1b';

/** A DescribeStacks reply exposing the consent-page output. */
function stackServingConsentUrl(): void {
  cfnSend.mockResolvedValue({
    Stacks: [{ Outputs: [{ OutputKey: 'LinearVaultConsentUrl', OutputValue: HOSTED }] }],
  });
}

/** A deployed stack with the vault flag OFF — the output is legitimately absent. */
function stackWithoutConsentUrl(): void {
  cfnSend.mockResolvedValue({
    Stacks: [{ Outputs: [{ OutputKey: 'ApiUrl', OutputValue: 'https://api.example.com' }] }],
  });
}

beforeEach(() => {
  jest.restoreAllMocks();
  cfnSend.mockReset();
  lookupVaultCallback.mockReset();
  lookupVaultCallback.mockResolvedValue(null);
  jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-east-1' } as never);
});

describe('app-template callback discovery', () => {
  test('resolves BOTH URLs so the operator has to look up neither', async () => {
    stackServingConsentUrl();
    lookupVaultCallback.mockResolvedValue(VAULT);
    await expect(resolveTemplateCallbackUrls({ stackName: 'backgroundagent-dev', slug: 'acme' }))
      .resolves.toEqual({ hostedConsentUrl: HOSTED, vaultCallbackUrl: VAULT });
  });

  test('reads the region from config when not passed, so the flag is optional', async () => {
    stackServingConsentUrl();
    const out = await resolveTemplateCallbackUrls({ stackName: 'backgroundagent-dev' });
    expect(out.hostedConsentUrl).toBe(HOSTED);
    expect(config.loadConfig).toHaveBeenCalled();
  });

  test('an explicit --region wins for the stack lookup', async () => {
    stackServingConsentUrl();
    await resolveTemplateCallbackUrls({ region: 'eu-west-1', stackName: 'st' });
    expect(jest.mocked(CloudFormationClient)).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'eu-west-1' }),
    );
  });

  test('the webhook URL comes from config, so it resolves with no AWS call at all', async () => {
    // It is pure string work on the configured API URL. The template used to print
    // a placeholder here, which left operators with an app that could never
    // deliver an event.
    jest.spyOn(config, 'loadConfig').mockReturnValue({
      region: 'us-east-1',
      api_url: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1',
    } as never);
    const out = await resolveTemplateCallbackUrls({});
    expect(out.webhookUrl).toBe('https://abc123.execute-api.us-east-1.amazonaws.com/v1/linear/webhook');
    expect(cfnSend).not.toHaveBeenCalled();
  });

  test('a trailing slash on the configured API URL does not double up', async () => {
    jest.spyOn(config, 'loadConfig').mockReturnValue({
      region: 'us-east-1',
      api_url: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1/',
    } as never);
    const out = await resolveTemplateCallbackUrls({});
    expect(out.webhookUrl).toBe('https://abc123.execute-api.us-east-1.amazonaws.com/v1/linear/webhook');
  });

  test('no api_url in config yields no webhook URL rather than a malformed one', async () => {
    jest.spyOn(config, 'loadConfig').mockReturnValue({ region: 'us-east-1' } as never);
    const out = await resolveTemplateCallbackUrls({});
    expect(out.webhookUrl).toBeUndefined();
  });

  test('an UNCONFIGURED CLI yields no URLs instead of throwing', async () => {
    // The expected state on a first run: `bgagent configure` has not been run yet.
    jest.spyOn(config, 'loadConfig').mockImplementation(() => { throw new Error('Not configured'); });
    await expect(resolveTemplateCallbackUrls({ stackName: 'st', slug: 'acme' }))
      .resolves.toEqual({ webhookUrl: undefined });
    // And it must not have tried to call AWS with an undefined region.
    expect(cfnSend).not.toHaveBeenCalled();
    expect(lookupVaultCallback).not.toHaveBeenCalled();
  });

  test('an undeployed stack yields no hosted URL, not an error', async () => {
    const err = Object.assign(new Error('Stack with id st does not exist'), { name: 'ValidationError' });
    cfnSend.mockRejectedValue(err);
    await expect(resolveTemplateCallbackUrls({ stackName: 'st', slug: 'acme' })).resolves.toEqual({});
  });

  test('an AUTH failure also degrades to no URL — a template must render without credentials', async () => {
    // getStackOutput deliberately rethrows non-"does not exist" errors; this command
    // is the one caller that must not propagate them, or `app-template` would be
    // unusable before `aws configure`.
    cfnSend.mockRejectedValue(Object.assign(new Error('Unable to locate credentials'), {
      name: 'CredentialsProviderError',
    }));
    await expect(resolveTemplateCallbackUrls({ stackName: 'st', slug: 'acme' })).resolves.toEqual({});
  });

  test('a stack without the vault output yields no hosted URL (flag-off deploy)', async () => {
    stackWithoutConsentUrl();
    await expect(resolveTemplateCallbackUrls({ stackName: 'st' })).resolves.toEqual({});
  });

  test('without a slug the vault lookup is SKIPPED — the provider is per-workspace', async () => {
    stackServingConsentUrl();
    const out = await resolveTemplateCallbackUrls({ stackName: 'st' });
    expect(lookupVaultCallback).not.toHaveBeenCalled();
    expect(out).toEqual({ hostedConsentUrl: HOSTED });
  });

  test('a not-yet-created provider yields no vault URL while still returning the hosted one', async () => {
    // The ordinary first run: the hosted page exists, the provider does not.
    stackServingConsentUrl();
    lookupVaultCallback.mockResolvedValue(null);
    await expect(resolveTemplateCallbackUrls({ stackName: 'st', slug: 'acme' }))
      .resolves.toEqual({ hostedConsentUrl: HOSTED });
  });

  test('looks the provider up by the slug it was given', async () => {
    stackWithoutConsentUrl();
    lookupVaultCallback.mockResolvedValue(VAULT);
    await resolveTemplateCallbackUrls({ stackName: 'st', slug: 'acme' });
    expect(lookupVaultCallback).toHaveBeenCalledWith({ region: 'us-east-1', workspaceSlug: 'acme' });
  });

  test('no stack name means no stack lookup', async () => {
    await resolveTemplateCallbackUrls({ slug: 'acme' });
    expect(cfnSend).not.toHaveBeenCalled();
  });
});
