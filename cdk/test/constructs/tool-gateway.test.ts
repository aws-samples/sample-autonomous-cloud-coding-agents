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

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import {
  REPO_CONFIG_TOOL_NAME,
  ToolGateway,
} from '../../src/constructs/tool-gateway';

function makeStack(): { stack: Stack; gateway: ToolGateway } {
  const app = new App();
  const stack = new Stack(app, 'TestStack');
  const repoTable = new dynamodb.Table(stack, 'RepoTable', {
    partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
  });
  const gateway = new ToolGateway(stack, 'ToolGateway', { repoTable });
  return { stack, gateway };
}

function synth(): Template {
  return Template.fromStack(makeStack().stack);
}

describe('ToolGateway', () => {
  // Synth once for the template-shape assertions (#366 — per-test synth is the
  // main CDK test-suite cost). The few tests that need a fresh construct
  // *instance* (mutating the L2, attaching a grantee) call makeStack()
  // themselves; they are isolated by nature and can't share this template.
  let template: Template;
  beforeAll(() => {
    template = synth();
  });

  test('creates exactly one Gateway with AWS_IAM (SigV4) inbound auth', () => {
    // The L2 default authorizer is Cognito (it silently creates a user pool);
    // ADR-019 P1 requires SigV4, so AuthorizerType MUST be AWS_IAM.
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
      AuthorizerType: 'AWS_IAM',
      ProtocolType: 'MCP',
    });
  });

  test('federates a single Lambda target with GATEWAY_IAM_ROLE outbound (no vaulted credential)', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: 'abca-repo-config',
      CredentialProviderConfigurations: [
        { CredentialProviderType: 'GATEWAY_IAM_ROLE' },
      ],
    });
  });

  test('the target exposes the abca_repo_config tool via an inline schema requiring "repo"', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      TargetConfiguration: {
        Mcp: {
          Lambda: {
            LambdaArn: Match.anyValue(),
            ToolSchema: {
              InlinePayload: Match.arrayWith([
                Match.objectLike({
                  Name: REPO_CONFIG_TOOL_NAME,
                  InputSchema: Match.objectLike({
                    Type: 'object',
                    Required: ['repo'],
                    Properties: Match.objectLike({
                      repo: Match.objectLike({ Type: 'string' }),
                    }),
                  }),
                }),
              ]),
            },
          },
        },
      },
    });
  });

  test('the tool name is neutral (contains no "linear") so the agent scrubber never strips it', () => {
    // strip_linear_mcp_servers deletes any .mcp.json entry containing "linear";
    // the federated tool + target names must therefore stay neutral.
    expect(REPO_CONFIG_TOOL_NAME.toLowerCase()).not.toContain('linear');
    template.hasResourceProperties('AWS::BedrockAgentCore::GatewayTarget', {
      Name: Match.stringLikeRegexp('^(?!.*linear).*$'),
    });
  });

  test('the backing Lambda carries REPO_TABLE_NAME and the "gwtool" UA component (#319)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs24.x',
      Architectures: ['arm64'],
      Environment: {
        Variables: Match.objectLike({
          REPO_TABLE_NAME: Match.anyValue(),
          ABCA_COMPONENT: 'gwtool',
        }),
      },
    });
  });

  test('grants the backing Lambda read-only DynamoDB access (no write actions)', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['dynamodb:GetItem']),
          }),
        ]),
      },
    });
    // Read-only: the tool must never be able to mutate the RepoTable.
    const policies = template.findResources('AWS::IAM::Policy');
    const actions = JSON.stringify(policies);
    expect(actions).not.toContain('dynamodb:PutItem');
    expect(actions).not.toContain('dynamodb:UpdateItem');
    expect(actions).not.toContain('dynamodb:DeleteItem');
  });

  test('gatewayUrl returns the L2 endpoint URL when present', () => {
    const { gateway } = makeStack();
    // The L2 resolves gatewayUrl to a CloudFormation token at synth; the getter
    // must surface it (not undefined) so the env wiring gets a real value.
    expect(gateway.gatewayUrl).toBeDefined();
  });

  test('gatewayUrl throws (fails synth loudly) if the L2 exposes no URL', () => {
    const { gateway } = makeStack();
    // Simulate the L2 exposing no URL — rather than a `!` assertion that would
    // ship the literal "undefined" into the env, the getter must throw.
    Object.defineProperty(gateway.gateway, 'gatewayUrl', {
      value: undefined,
      configurable: true,
    });
    expect(() => gateway.gatewayUrl).toThrow(/gatewayUrl is undefined/);
  });

  test('grantInvoke attaches bedrock-agentcore:InvokeGateway to the grantee', () => {
    const { stack, gateway } = makeStack();
    const runtime = new Role(stack, 'RuntimeRole', {
      assumedBy: new ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    });
    gateway.grantInvoke(runtime);

    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'bedrock-agentcore:InvokeGateway',
          }),
        ]),
      },
    });
  });
});
