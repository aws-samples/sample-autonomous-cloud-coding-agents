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

import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  type Stack,
} from '@aws-sdk/client-cloudformation';
import { isGithubTokenConfigured, putGithubToken, resolveGithubTokenSecretArn } from '../../src/github-token';
import { makeClient } from '../../src/ua';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const SETUP_TIMEOUT_MS = 30_000;
const STACK_WAIT_MS = 20_000;
const POLL_INTERVAL_MS = 50;

const STACK_TEMPLATE = {
  AWSTemplateFormatVersion: '2010-09-09',
  Resources: {
    GitHubTokenSecret: {
      Type: 'AWS::SecretsManager::Secret',
      Properties: {
        Description: 'GitHub personal access token for the background agent',
        GenerateSecretString: {},
      },
    },
  },
  Outputs: { GitHubTokenSecretArn: { Value: { Ref: 'GitHubTokenSecret' } } },
};

async function settledStack(cloudFormation: CloudFormationClient, stackName: string): Promise<Stack> {
  const deadline = Date.now() + STACK_WAIT_MS;
  while (Date.now() < deadline) {
    const stack = (await cloudFormation.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    if (stack?.StackStatus && !stack.StackStatus.endsWith('_IN_PROGRESS')) return stack;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Fixture stack ${stackName} was still in progress after ${STACK_WAIT_MS} ms`);
}

describe('the platform GitHub token secret of a new stack', () => {
  const stackName = `bgagent-cli-emulator-token-${Date.now().toString(36)}`;
  let cloudFormation: CloudFormationClient;
  let secretArn: string;

  beforeAll(async () => {
    cloudFormation = makeClient(CloudFormationClient, { region: REGION });
    await cloudFormation.send(new CreateStackCommand({ StackName: stackName, TemplateBody: JSON.stringify(STACK_TEMPLATE) }));
    const stack = await settledStack(cloudFormation, stackName);
    if (stack.StackStatus !== 'CREATE_COMPLETE') {
      throw new Error(`Fixture stack ${stackName} ended in ${stack.StackStatus}: ${stack.StackStatusReason ?? 'no reason given'}`);
    }
    ({ secretArn } = await resolveGithubTokenSecretArn({ region: REGION, stackName }));
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await cloudFormation?.send(new DeleteStackCommand({ StackName: stackName }));
  }, SETUP_TIMEOUT_MS);

  test('a secret nobody has set is not a configured token', async () => {
    await expect(isGithubTokenConfigured(REGION, secretArn)).resolves.toBe(false);
  });

  test('it is configured once a token is stored', async () => {
    await putGithubToken(REGION, secretArn, `ghp_${'a1B2'.repeat(9)}`);

    await expect(isGithubTokenConfigured(REGION, secretArn)).resolves.toBe(true);
  });
});
