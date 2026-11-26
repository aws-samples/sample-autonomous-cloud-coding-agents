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

import * as path from 'path';
import { Duration, Stack } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Architecture, CfnFunction, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * The MCP tool name this gateway federates (ADR-019).
 */
export const REPO_CONFIG_TOOL_NAME = 'abca_repo_config';

/**
 * Gateway prefixes the tool as ``<targetName>___<toolName>`` in the Lambda client
 * context.
 */
const REPO_CONFIG_TARGET_NAME = 'abca-repo-config';

export interface ToolGatewayProps {
  /**
   * RepoTable the ``abca_repo_config`` tool reads (GetItem, read-only). The
   * construct grants the backing Lambda read access and wires
   * ``REPO_TABLE_NAME``.
   */
  readonly repoTable: dynamodb.ITable;
}

/**
 * AgentCore Gateway that federates ABCA's agent-facing MCP tools behind a
 * single managed endpoint (ADR-019), with one read-only Lambda target
 * (``abca_repo_config``).
 *
 * Auth model:
 * - **Inbound** — ``AWS_IAM`` (SigV4). The agent signs Gateway requests with its
 *   task role. The L2 default authorizer is Cognito (it creates a user pool), so
 *   {@link agentcore.GatewayAuthorizer.usingAwsIam} is passed explicitly.
 * - **Outbound** — the gateway execution role (``GATEWAY_IAM_ROLE``), no vaulted
 *   credential. ``addLambdaTarget`` defaults the target's credential provider to
 *   {@link agentcore.GatewayCredentialProvider.fromIamRole} and grants the
 *   gateway role ``lambda:InvokeFunction`` on the target Lambda.
 */
export class ToolGateway extends Construct {
  public readonly gateway: agentcore.Gateway;

  public readonly repoConfigFn: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: ToolGatewayProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    this.repoConfigFn = new lambda.NodejsFunction(this, 'RepoConfigFn', {
      entry: path.join(handlersDir, 'tool-repo-config.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      memorySize: 256,
      environment: {
        REPO_TABLE_NAME: props.repoTable.tableName,
        ABCA_COMPONENT: 'gwtool',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    props.repoTable.grantReadData(this.repoConfigFn);

    this.gateway = new agentcore.Gateway(this, 'Gateway', {
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam(),
      description: 'ABCA agent tool federation (ADR-019). SigV4 inbound; gateway-role outbound.',
    });

    this.gateway.addLambdaTarget('RepoConfigTarget', {
      gatewayTargetName: REPO_CONFIG_TARGET_NAME,
      description: "Look up a repo's ABCA onboarding config (compute substrate, model, build/lint commands).",
      lambdaFunction: this.repoConfigFn,
      toolSchema: agentcore.ToolSchema.fromInline([
        {
          name: REPO_CONFIG_TOOL_NAME,
          description:
            'Look up the ABCA onboarding configuration for a GitHub repository — its compute '
            + 'substrate, model, and the build/lint commands ABCA gates PRs against. Use this to '
            + "align your build verification with what the platform's CI expects for this repo.",
          inputSchema: {
            type: agentcore.SchemaDefinitionType.OBJECT,
            properties: {
              repo: {
                type: agentcore.SchemaDefinitionType.STRING,
                description: 'The repository in "owner/name" form, e.g. "aws-samples/my-repo".',
              },
            },
            required: ['repo'],
          },
        },
      ]),
    });

    const functionId = Stack.of(this).getLogicalId(this.repoConfigFn.node.defaultChild as CfnFunction);
    NagSuppressions.addResourceSuppressions(this.gateway.role, [{
      id: 'AwsSolutions-IAM5',
      reason: 'CDK Lambda target binding grants invoke on the single RepoConfig function and its qualified versions; it cannot invoke other functions.',
      appliesTo: [`Resource::<${functionId}.Arn>:*`],
    }], true);

    NagSuppressions.addResourceSuppressions(this.repoConfigFn, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'DynamoDB index/* ARN wildcard generated by CDK grantReadData on the RepoTable',
      },
    ], true);
  }

  /**
   * The Gateway MCP endpoint URL the agent's in-process SigV4 bridge signs
   * against (wired as ``ABCA_TOOL_GATEWAY_URL`` on every substrate role).
   * Throws when the L2's ``Gateway.gatewayUrl`` is undefined.
   */
  public get gatewayUrl(): string {
    const url = this.gateway.gatewayUrl;
    if (!url) {
      throw new Error(
        'ToolGateway: gateway.gatewayUrl is undefined — the AgentCore Gateway L2 '
        + 'did not expose an endpoint URL, so the agent bridge cannot be wired.',
      );
    }
    return url;
  }

  /**
   * Grant a principal (the agent's runtime / task role) permission to invoke
   * this gateway over SigV4 (``bedrock-agentcore:InvokeGateway``). Call once per
   * substrate role (AgentCore runtime, ECS task role) for parity.
   */
  public grantInvoke(grantee: IGrantable): void {
    this.gateway.grantInvoke(grantee);
  }
}
