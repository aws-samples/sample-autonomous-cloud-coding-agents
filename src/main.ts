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

import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgentStack } from './stacks/agent';
import { FargateAgentStack } from './stacks/fargate-agent';

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

Aspects.of(app).add(new AwsSolutionsChecks());

const agentStack = new AgentStack(
  app,
  'backgroundagent-dev',
  {
    env: devEnv,
    description: 'ABCA Development Stack',
  },
);

new FargateAgentStack(app, 'backgroundagent-fargate-dev', {
  env: devEnv,
  description: 'ABCA Fargate Development Stack',
  vpc: agentStack.agentVpc.vpc,
  runtimeSecurityGroup: agentStack.agentVpc.runtimeSecurityGroup,
  taskTable: agentStack.taskTable.table,
  taskEventsTable: agentStack.taskEventsTable.table,
  userConcurrencyTable: agentStack.userConcurrencyTable.table,
  repoTable: agentStack.repoTable.table,
  githubTokenSecret: agentStack.githubTokenSecret,
  memoryId: agentStack.agentMemory?.memory.memoryId,
});

app.synth();
