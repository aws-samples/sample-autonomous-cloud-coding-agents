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

import { App, Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { buildAppId, SolutionUaAspect } from './constructs/solution-ua-aspect';
import { AgentStack } from './stacks/agent';

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

Aspects.of(app).add(new AwsSolutionsChecks());

const stackName = app.node.tryGetContext('stackName') ?? 'backgroundagent-dev';

const stack = new AgentStack(
  app,
  stackName,
  {
    env: devEnv,
    description: 'ABCA Development Stack (uksb-wt64nei4u6)',
  },
);

// Outbound SDK solution attribution (#319): set AWS_SDK_UA_APP_ID on every
// Lambda so the SDK emits `app/uksb-wt64nei4u6#{stackName}` natively. One
// Aspect covers current and future functions structurally. Override via
// `-c sdkUaAppId=...`; `-c sdkUaAppId=''` opts out (no app/ segment anywhere).
const sdkUaAppIdOverride = app.node.tryGetContext('sdkUaAppId') as string | undefined;
Aspects.of(stack).add(new SolutionUaAspect(buildAppId(stackName, sdkUaAppIdOverride)));

const computeType = app.node.tryGetContext('compute_type') ?? 'agentcore';

// Route53 Resolver resources where tag changes trigger replacement cascades.
// Config: treats ANY property change (including tags) as requiring replacement.
// Association: depends on Config's physical ID; if Config is replaced, the
// Association update fails on the one-association-per-VPC constraint.
const excludeResourceTypes = [
  'AWS::Route53Resolver::ResolverQueryLoggingConfig',
  'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation',
];

Tags.of(stack).add('compute_type', computeType, { excludeResourceTypes });

const githubTagKeys = [
  'sha',
  'ref',
  'ref-type',
  'actor',
  'head-ref',
  'base-ref',
  'pr-number',
  'run-id',
  'run-attempt',
  'event',
  'workflow',
  'repository',
  'clean',
] as const;

for (const key of githubTagKeys) {
  const value = app.node.tryGetContext(`github:${key}`);
  Tags.of(stack).add(`github:${key}`, value || 'none', { excludeResourceTypes });
}

app.synth();
