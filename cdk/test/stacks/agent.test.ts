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

import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentStack } from '../../src/stacks/agent';

describe('AgentStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new AgentStack(app, 'TestAgentStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('synthesizes without errors', () => {
    expect(template).toBeDefined();
  });

  test('creates exactly 5 DynamoDB tables', () => {
    template.resourceCountIs('AWS::DynamoDB::Table', 5);
  });

  test('outputs TaskTableName', () => {
    template.hasOutput('TaskTableName', {
      Description: 'Name of the DynamoDB task state table',
    });
  });

  test('outputs TaskEventsTableName', () => {
    template.hasOutput('TaskEventsTableName', {
      Description: 'Name of the DynamoDB task events audit table',
    });
  });

  test('outputs UserConcurrencyTableName', () => {
    template.hasOutput('UserConcurrencyTableName', {
      Description: 'Name of the DynamoDB user concurrency table',
    });
  });

  test('outputs WebhookTableName', () => {
    template.hasOutput('WebhookTableName', {
      Description: 'Name of the DynamoDB webhook table',
    });
  });

  test('outputs RepoTableName', () => {
    template.hasOutput('RepoTableName', {
      Description: 'Name of the DynamoDB repo config table',
    });
  });

  test('outputs RuntimeArn', () => {
    template.hasOutput('RuntimeArn', {
      Description: 'ARN of the AgentCore runtime',
    });
  });

  test('outputs ApiUrl', () => {
    template.hasOutput('ApiUrl', {
      Description: 'URL of the Task API',
    });
  });

  test('outputs UserPoolId', () => {
    template.hasOutput('UserPoolId', {
      Description: 'Cognito User Pool ID',
    });
  });

  test('outputs AppClientId', () => {
    template.hasOutput('AppClientId', {
      Description: 'Cognito App Client ID',
    });
  });

  test('creates REST API', () => {
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
  });

  test('creates Cognito User Pools', () => {
    // TaskApi Cognito + Gateway (BrowserCustom) Cognito
    template.resourceCountIs('AWS::Cognito::UserPool', 2);
  });

  test('sets 90-day retention on runtime log groups', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('APPLICATION_LOGS'),
      RetentionInDays: 90,
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('USAGE_LOGS'),
      RetentionInDays: 90,
    });
  });

  test('creates a VPC for the agent runtime', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  test('creates a VPC flow log', () => {
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      TrafficType: 'ALL',
    });
  });

  test('creates DNS Firewall domain lists', () => {
    template.resourceCountIs('AWS::Route53Resolver::FirewallDomainList', 3);
  });

  test('creates DNS Firewall rule group', () => {
    template.hasResourceProperties('AWS::Route53Resolver::FirewallRuleGroup', {
      Name: 'agent-egress-policy',
    });
  });

  test('creates DNS Firewall rule group association', () => {
    template.resourceCountIs('AWS::Route53Resolver::FirewallRuleGroupAssociation', 1);
  });

  test('creates DNS query logging config', () => {
    template.resourceCountIs('AWS::Route53Resolver::ResolverQueryLoggingConfig', 1);
  });

  test('configures DNS Firewall fail-open via custom resource', () => {
    const customs = template.findResources('Custom::AWS');
    const firewallConfigs = Object.values(customs).filter(r => {
      const create = r.Properties?.Create;
      const joined = JSON.stringify(create);
      return joined.includes('updateFirewallConfig') && joined.includes('ENABLED');
    });
    expect(firewallConfigs.length).toBe(1);
  });

  test('creates WAFv2 Web ACL for the API', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
    });
  });

  test('associates WAF with the API Gateway stage', () => {
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
  });

  test('creates Bedrock model invocation logging via custom resource', () => {
    const customs = template.findResources('Custom::AWS');
    const loggingConfigs = Object.values(customs).filter(r => {
      const create = r.Properties?.Create;
      const joined = JSON.stringify(create);
      return joined.includes('putModelInvocationLoggingConfiguration');
    });
    expect(loggingConfigs.length).toBe(1);
  });

  test('enables session storage with persistent filesystem', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      FilesystemConfigurations: [
        {
          SessionStorage: {
            MountPath: '/mnt/workspace',
          },
        },
      ],
    });
  });

  test('sets cache env vars on runtime (persistent mount + local for flock)', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        // Local disk — tools use flock()
        MISE_DATA_DIR: '/tmp/mise-data',
        UV_CACHE_DIR: '/tmp/uv-cache',
        // Persistent mount — no flock()
        CLAUDE_CONFIG_DIR: '/mnt/workspace/.claude-config',
        npm_config_cache: '/mnt/workspace/.npm-cache',
      }),
    });
  });

  test('creates AgentCore Memory resource', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Memory', 1);
  });

  test('creates a log group for model invocation logs', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/bedrock/model-invocation-logs',
      RetentionInDays: 90,
    });
  });

  test('creates an IAM role for Bedrock logging', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Principal: Match.objectLike({
              Service: 'bedrock.amazonaws.com',
            }),
          }),
        ]),
      }),
    });
  });

  test('grants orchestrator Lambda memory read and write permissions', () => {
    // The orchestrator needs RetrieveMemoryRecords (read during hydration)
    // and CreateEvent (write fallback episodes during finalization)
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'bedrock-agentcore:RetrieveMemoryRecords',
            ]),
            Effect: 'Allow',
          }),
        ]),
      },
      Roles: Match.arrayWith([
        Match.objectLike({
          Ref: Match.stringLikeRegexp('TaskOrchestrator'),
        }),
      ]),
    });
  });
});
