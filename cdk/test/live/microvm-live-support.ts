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

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  GetMicrovmCommand, GetMicrovmImageCommand, LambdaMicrovmsClient,
  ListMicrovmsCommand, TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { redactPayloadUrls } from '../../src/handlers/shared/payload-bootstrap';
import { makeClient } from '../../src/handlers/shared/ua';

export interface LiveTarget {
  account: string;
  region: string;
  stack: string;
  imageVersion: string;
}

const command = promisify(execFile);

export function safeError(error: unknown): string {
  return redactPayloadUrls(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

export async function connectMicrovm(target: LiveTarget) {
  process.env.AWS_REGION = target.region;
  process.env.AWS_DEFAULT_REGION = target.region;
  const aws = async <T>(args: string[]): Promise<T> => {
    const response = await command('aws', [...args, '--region', target.region, '--output', 'json'], {
      timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    });
    return JSON.parse(response.stdout) as T;
  };
  // A single SDK attempt exposes the actual response to each probe.
  const cfg = { region: target.region, maxAttempts: 1 };
  const identity = await makeClient(STSClient, cfg).send(new GetCallerIdentityCommand({}));
  assert.equal(identity.Account, target.account, 'Wrong AWS account');
  const stack = (await aws<{
    Stacks: { StackId: string; StackStatus: string; Outputs: { OutputKey: string; OutputValue: string }[] }[];
  }>(['cloudformation', 'describe-stacks', '--stack-name', target.stack])).Stacks[0]!;
  assert(['CREATE_COMPLETE', 'UPDATE_COMPLETE'].includes(stack.StackStatus), 'Stack is not ready');
  const outputs = Object.fromEntries(stack.Outputs.map(o => [o.OutputKey, o.OutputValue]));
  const resources = (await aws<{
    StackResourceSummaries: { ResourceType: string; LogicalResourceId: string; PhysicalResourceId: string }[];
  }>(['cloudformation', 'list-stack-resources', '--stack-name', target.stack])).StackResourceSummaries;
  const fn = resources.find(r => r.ResourceType === 'AWS::Lambda::Function'
    && r.LogicalResourceId.startsWith('TaskOrchestratorOrchestratorFn'))?.PhysicalResourceId;
  assert(fn, 'Cannot identify coordinator');
  const configuration = await makeClient(LambdaClient, cfg).send(new GetFunctionConfigurationCommand({ FunctionName: fn }));
  const env = configuration.Environment?.Variables ?? {};
  const image = env.MICROVM_IMAGE_IDENTIFIER;
  const executionRole = env.MICROVM_EXECUTION_ROLE_ARN;
  const ingress = env.MICROVM_INGRESS_CONNECTOR_ARNS?.split(',') ?? [];
  const egress = env.MICROVM_EGRESS_CONNECTOR_ARNS?.split(',') ?? [];
  const logGroup = outputs.MicrovmLogGroupName;
  assert(image && executionRole && logGroup && egress.length, 'Missing MicroVM configuration');
  assert.equal(executionRole, outputs.MicrovmExecutionRoleArn);
  assert.equal(ingress.length, 1);
  assert(ingress[0]!.endsWith(':NO_INGRESS'), 'Live probes require NO_INGRESS');
  const mv = makeClient(LambdaMicrovmsClient, cfg);
  const info = await mv.send(new GetMicrovmImageCommand({ imageIdentifier: image }));
  assert.equal(info.latestActiveImageVersion, target.imageVersion, 'Unexpected active image');
  return { aws, mv, image, executionRole, ingress, egress, logGroup, env, stackId: stack.StackId };
}

export async function listWorkers(mv: LambdaMicrovmsClient, image: string) {
  const workers = [];
  let nextToken: string | undefined;
  do {
    const page = await mv.send(new ListMicrovmsCommand({ imageIdentifier: image, nextToken, maxResults: 50 }));
    workers.push(...(page.items ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return workers;
}

export async function stopWorker(mv: LambdaMicrovmsClient, id: string): Promise<void> {
  const first = await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
  if (first.state === 'TERMINATED') return;
  if (first.state !== 'TERMINATING') await mv.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
    if (state.state === 'TERMINATED') return;
    await delay(2_000);
  }
  throw new Error(`Termination not confirmed for ${id}`);
}
