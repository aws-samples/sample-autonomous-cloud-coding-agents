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
 * The CLI's real sign-in path against an AWS Emulator
 * (https://github.com/aws/aws-emulator) instead of a mocked SDK (ADR-013
 * Tier 2a).
 *
 * Nothing here is mocked. `bgagent configure --stack-name` reads a real
 * CloudFormation stack's outputs, and `login` / `getAuthToken` /
 * `changePassword` talk to the Cognito user pool that stack created, so the
 * assertions are about what the service answers (JWT claims, error names, the
 * pool's password policy) rather than about what a mock was told to return.
 *
 * Named `*.emulator.ts`, which the unit configuration does not match. It runs
 * only through `jest.emulator.config.js` (`mise run test:integration`), which
 * refuses to start unless the AWS environment is the emulator's and the
 * emulator answers.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import { changePassword, getAuthToken, login } from '../../src/auth';
import { adminInviteUser, adminResetPassword, resolveCognitoAdminContext } from '../../src/cognito-admin';
import { makeConfigureCommand } from '../../src/commands/configure';
import { loadConfig, loadCredentials, saveCredentials } from '../../src/config';
import { makeClient } from '../../src/ua';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const SETUP_TIMEOUT_MS = 30_000;
/** Shorter than the hook, so a stack that never settles reports itself instead of a bare hook timeout. */
const STACK_WAIT_MS = 20_000;
const POLL_INTERVAL_MS = 50;

const TEMP_PASSWORD = 'T3mp$trongPass!';
const PASSWORD = 'N3w$trongPass!';
const NEXT_PASSWORD = 'An0ther$trongPass!';

/**
 * The two resources the sign-in path needs, shaped like the ones
 * `cdk/src/constructs/task-api.ts` synthesizes (email as the username, the
 * 12-character policy, password + refresh auth flows, no client secret), with
 * the outputs `bgagent configure --stack-name` reads.
 */
const STACK_TEMPLATE = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    UserPool: {
      Type: 'AWS::Cognito::UserPool',
      Properties: {
        UsernameAttributes: ['email'],
        AutoVerifiedAttributes: ['email'],
        AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
        Policies: {
          PasswordPolicy: {
            MinimumLength: 12,
            RequireLowercase: true,
            RequireUppercase: true,
            RequireNumbers: true,
            RequireSymbols: true,
          },
        },
      },
    },
    AppClient: {
      Type: 'AWS::Cognito::UserPoolClient',
      Properties: {
        UserPoolId: { Ref: 'UserPool' },
        ExplicitAuthFlows: ['ALLOW_USER_PASSWORD_AUTH', 'ALLOW_USER_SRP_AUTH', 'ALLOW_REFRESH_TOKEN_AUTH'],
        GenerateSecret: false,
      },
    },
  },
  Outputs: {
    ApiUrl: { Value: 'https://api.invalid/v1/' },
    UserPoolId: { Value: { Ref: 'UserPool' } },
    AppClientId: { Value: { Ref: 'AppClient' } },
  },
};

/** Claims of an ID token; the signature is not checked (the CLI never checks it either). */
function idTokenClaims(idToken: string): Record<string, unknown> {
  const [, payload] = idToken.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8')) as Record<string, unknown>;
}

async function settledStack(cloudFormation: CloudFormationClient, stackName: string): Promise<Stack> {
  const deadline = Date.now() + STACK_WAIT_MS;
  while (Date.now() < deadline) {
    const stack = (await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    if (stack?.StackStatus && !stack.StackStatus.endsWith('_IN_PROGRESS')) return stack;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Fixture stack ${stackName} was still in progress after ${STACK_WAIT_MS} ms`);
}

describe('bgagent sign-in against an AWS Emulator', () => {
  const stackName = `bgagent-cli-emulator-${Date.now().toString(36)}`;
  let cloudFormation: CloudFormationClient;
  let stackOutputs: Map<string | undefined, string | undefined>;
  let configDir: string;
  let userCount = 0;

  /** A fresh user in FORCE_CHANGE_PASSWORD, as `bgagent admin invite-user` leaves it. */
  async function invitedUser(): Promise<string> {
    userCount += 1;
    const email = `user-${userCount}@example.com`;
    await adminInviteUser(await resolveCognitoAdminContext({ region: REGION, stackName }), email, TEMP_PASSWORD);
    return email;
  }

  /** A fresh user with a permanent password, as `bgagent admin reset-password` leaves it. */
  async function confirmedUser(): Promise<string> {
    const email = await invitedUser();
    await adminResetPassword(await resolveCognitoAdminContext({ region: REGION, stackName }), email, PASSWORD);
    return email;
  }

  beforeAll(async () => {
    // First, before any CLI code runs: the CLI keeps its config and tokens under
    // ~/.bgagent, and this suite must never read or replace the developer's own.
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-emulator-'));
    process.env.BGAGENT_CONFIG_DIR = configDir;

    cloudFormation = makeClient(CloudFormationClient, { region: REGION });
    await cloudFormation.send(new CreateStackCommand({ StackName: stackName, TemplateBody: JSON.stringify(STACK_TEMPLATE) }));
    const stack = await settledStack(cloudFormation, stackName);
    if (stack.StackStatus !== 'CREATE_COMPLETE') {
      throw new Error(`Fixture stack ${stackName} ended in ${stack.StackStatus}: ${stack.StackStatusReason ?? 'no reason given'}`);
    }
    stackOutputs = new Map((stack.Outputs ?? []).map((output) => [output.OutputKey, output.OutputValue]));

    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await makeConfigureCommand().parseAsync(['node', 'configure', '--stack-name', stackName, '--region', REGION]);
    } finally {
      log.mockRestore();
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    if (configDir) fs.rmSync(configDir, { recursive: true, force: true });
    await cloudFormation?.send(new DeleteStackCommand({ StackName: stackName }));
  }, SETUP_TIMEOUT_MS);

  /** Token cache inside the suite's own directory (never derived from the CLI's default). */
  const credentialsFile = (): string => path.join(configDir, 'credentials.json');

  beforeEach(() => {
    fs.rmSync(credentialsFile(), { force: true });
  });

  test('configure --stack-name stores the pool and client the stack created', () => {
    expect(stackOutputs.get('UserPoolId')).toMatch(new RegExp(`^${REGION}_`));
    expect(loadConfig()).toEqual({
      api_url: 'https://api.invalid/v1/',
      region: REGION,
      user_pool_id: stackOutputs.get('UserPoolId'),
      client_id: stackOutputs.get('AppClientId'),
      stack_name: stackName,
    });
  });

  test('an invited user is challenged for a new password and nothing is cached', async () => {
    const email = await invitedUser();

    await expect(login(email, TEMP_PASSWORD)).rejects.toThrow(/requires a new password on first login/);

    expect(loadCredentials()).toBeNull();
  });

  // Emulator 1.0.385 answers 501 NotImplemented for RespondToAuthChallenge with
  // NEW_PASSWORD_REQUIRED, so the rotation itself cannot run yet (upstream:
  // aws/aws-emulator issues/things-that-do-not-work/
  // 20261029T182116Z-cognito-idp-mfa-challenge-state-machine-mfa-setup.md). The
  // body is the test we want; when an emulator release makes it pass, jest
  // reports this case as failed and `.failing` can simply be dropped.
  test.failing('first sign-in rotates the temporary password (blocked by an emulator gap)', async () => {
    const email = await invitedUser();

    await login(email, TEMP_PASSWORD, () => Promise.resolve(PASSWORD));

    expect(loadCredentials()).not.toBeNull();
  });

  test('login caches an ID token for the user, and an expired cache is refreshed', async () => {
    const email = await confirmedUser();

    await login(email, PASSWORD);

    const cached = loadCredentials();
    expect(fs.statSync(credentialsFile()).mode % 0o1000).toBe(0o600);
    const claims = idTokenClaims(cached!.id_token);
    expect(claims).toMatchObject({ email, token_use: 'id', aud: loadConfig().client_id });
    expect(claims.iss).toBe(`https://cognito-idp.${REGION}.amazonaws.com/${loadConfig().user_pool_id}`);
    await expect(getAuthToken()).resolves.toBe(cached!.id_token);

    saveCredentials({ ...cached!, token_expiry: new Date(0).toISOString() });
    const refreshed = idTokenClaims(await getAuthToken());

    expect(refreshed).toMatchObject({ email, sub: claims.sub });
    expect(loadCredentials()!.refresh_token).toBe(cached!.refresh_token);
    expect(Date.parse(loadCredentials()!.token_expiry)).toBeGreaterThan(Date.now());
  });

  test('change-password verifies the current password, applies the pool policy, then rotates', async () => {
    const email = await confirmedUser();
    await login(email, PASSWORD);

    await expect(changePassword('Wr0ng$trongPass!', NEXT_PASSWORD)).rejects.toThrow('Current password is incorrect.');
    // The CLI's own prefix; what follows is the service's wording, which is not asserted.
    await expect(changePassword(PASSWORD, 'weak')).rejects.toThrow(/^New password rejected: /);
    await changePassword(PASSWORD, NEXT_PASSWORD);

    await expect(login(email, PASSWORD)).rejects.toThrow(/incorrect password/);
    await expect(login(email, NEXT_PASSWORD)).resolves.toBeUndefined();
  });
});
