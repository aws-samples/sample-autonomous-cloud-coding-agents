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

import * as fs from 'fs';
import * as path from 'path';
import { describeDataLoss, parseStateBearingChanges } from '../src/setup-diff';

const STACK = 'backgroundagent-dev';
/** Captured from aws-cdk 2.1129 `cdk diff` of the legacy topology without Linear (IAM tables trimmed). */
const REMOVE_LINEAR = fs.readFileSync(path.join(__dirname, 'fixtures', 'cdk-diff-remove-linear.txt'), 'utf-8');

describe('parseStateBearingChanges', () => {
  test('finds exactly the data a real cdk diff removes', () => {
    expect(parseStateBearingChanges(REMOVE_LINEAR)).toEqual([
      { change: 'delete', type: 'AWS::DynamoDB::Table', id: 'LinearIntegration/ProjectMappingTable/Table' },
      { change: 'delete', type: 'AWS::DynamoDB::Table', id: 'LinearIntegration/UserMappingTable/Table' },
      { change: 'delete', type: 'AWS::DynamoDB::Table', id: 'LinearIntegration/WorkspaceRegistryTable/Table' },
      { change: 'delete', type: 'AWS::DynamoDB::Table', id: 'LinearIntegration/WebhookDedupTable' },
      { change: 'delete', type: 'AWS::SecretsManager::Secret', id: 'LinearIntegration/WebhookSecret' },
    ]);
  });

  test('reads the impact word on resource lines', () => {
    const diff = [
      'Stack backgroundagent-dev',
      '\u001b[31m[-]\u001b[39m AWS::SecretsManager::Secret JiraIntegration/WebhookSecret JiraSecret destroy',
      '[~] AWS::DynamoDB::Table TaskTable TaskTable123 replace',
      ' └─ [~] KeySchema (requires replacement)',
      '[~] AWS::S3::Bucket ScreenshotBucket Bucket1 may be replaced',
      '[~] AWS::Logs::LogGroup Logs Logs1',
      '[-] AWS::Cognito::UserPool Pool Pool1 orphan',
      '[-] AWS::Lambda::Function Fn Fn1 destroy',
      '[+] AWS::DynamoDB::Table New New1',
      'Stack backgroundagent-dev/AgentRegistryStack',
      '[-] AWS::CloudFormation::Stack AgentRegistryStack.NestedStack/AgentRegistryStack.NestedStackResource Nested1 destroy',
    ].join('\n');
    expect(parseStateBearingChanges(diff)).toEqual([
      { change: 'delete', type: 'AWS::SecretsManager::Secret', id: 'JiraIntegration/WebhookSecret' },
      { change: 'replace', type: 'AWS::DynamoDB::Table', id: 'TaskTable' },
      { change: 'replace', type: 'AWS::S3::Bucket', id: 'ScreenshotBucket' },
      { change: 'orphan', type: 'AWS::Cognito::UserPool', id: 'Pool' },
      { change: 'delete', type: 'AWS::CloudFormation::Stack', id: 'AgentRegistryStack.NestedStack/AgentRegistryStack.NestedStackResource' },
    ]);
  });
});

describe('describeDataLoss', () => {
  test('counts what a real cdk diff removes, per component', () => {
    expect(describeDataLoss(parseStateBearingChanges(REMOVE_LINEAR), [STACK])).toEqual(['Linear: 4 tables, 1 secret']);
  });

  test('gives each component one line and each kind of resource its own count', () => {
    const changes = parseStateBearingChanges([
      `Stack ${STACK}`,
      '[-] AWS::DynamoDB::Table SlackIntegration/InstallationTable Installation1 destroy',
      '[~] AWS::DynamoDB::Table TaskTable/Table TaskTable1 replace',
      '[-] AWS::Logs::LogGroup TaskApi/AccessLogs AccessLogs1 destroy',
      '[-] AWS::Cognito::UserPool TaskApi/UserPool UserPool1 orphan',
      '[-] AWS::DynamoDB::Table SlackIntegration/UserMappingTable UserMapping1 destroy',
      `Stack ${STACK}/AgentRegistryStack`,
      '[-] AWS::CloudFormation::Stack AgentRegistryStack.NestedStack/AgentRegistryStack.NestedStackResource Nested1 destroy',
    ].join('\n'));
    expect(describeDataLoss(changes, [STACK])).toEqual([
      'Slack: 2 tables',
      'Task data & storage: 1 table',
      'Task API & sign-in: 1 log group, 1 user pool',
      'AWS Agent Registry: 1 nested stack',
    ]);
  });
});

describe('state-bearing resource types', () => {
  test.each([
    ['AWS::DynamoDB::Table', 'table'],
    ['AWS::DynamoDB::GlobalTable', 'table'],
    ['AWS::SecretsManager::Secret', 'secret'],
    ['AWS::S3::Bucket', 'bucket'],
    ['AWS::Cognito::UserPool', 'user pool'],
    ['AWS::KMS::Key', 'encryption key'],
    ['AWS::Logs::LogGroup', 'log group'],
    ['AWS::CloudFormation::Stack', 'nested stack'],
    ['AWS::BedrockAgentCore::Memory', 'agent memory'],
    ['AWS::EC2::VPC', 'VPC'],
  ])('finds the removal of %s and counts it as 1 %s', (type, noun) => {
    const changes = parseStateBearingChanges(`[-] ${type} TaskApi/Thing Thing1 destroy`);
    expect(changes).toEqual([{ change: 'delete', type, id: 'TaskApi/Thing' }]);
    expect(describeDataLoss(changes, [STACK])).toEqual([`Task API & sign-in: 1 ${noun}`]);
  });
});
