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
import { Duration } from 'aws-cdk-lib';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * The MCP tool name this gateway federates (ADR-019 P1 exemplar). Kept as a
 * const so the CDK inline schema and any assertions reference one string.
 */
export const REPO_CONFIG_TOOL_NAME = 'abca_repo_config';

/**
 * Gateway target name. Gateway prefixes the tool as ``<targetName>___<toolName>``
 * in the Lambda client context; the handler strips that prefix. Named neutrally
 * (no channel-specific term like "linear") as a general repo-wide convention.
 * NOTE: this is only a naming convention — the agent-side
 * ``strip_linear_mcp_servers`` scrubber operates solely on the cloned repo's
 * on-disk ``.mcp.json`` and never sees a CDK resource name, so it plays no part
 * in keeping this entry untouched.
 */
const REPO_CONFIG_TARGET_NAME = 'abca-repo-config';

/**
 * Properties for {@link ToolGateway}.
 */
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
 * single managed endpoint (ADR-019). This is the P1 slice: one read-only Lambda
 * target (``abca_repo_config``) proving the substrate-portable Gateway path end
 * to end, without OAuth.
 *
 * Auth model (ADR-019 P1):
 * - **Inbound** — ``AWS_IAM`` (SigV4). The agent signs Gateway requests with its
 *   task role; there is no Cognito user pool, JWT, or 3LO consent dance. NOTE:
 *   the L2 default authorizer is Cognito (it silently creates a user pool), so
 *   {@link agentcore.GatewayAuthorizer.usingAwsIam} is passed explicitly.
 * - **Outbound** — the gateway execution role (``GATEWAY_IAM_ROLE``), no vaulted
 *   credential. ``addLambdaTarget`` defaults the target's credential provider to
 *   {@link agentcore.GatewayCredentialProvider.fromIamRole} and auto-grants the
 *   gateway role ``lambda:InvokeFunction`` on the target Lambda, so no manual
 *   invoke grant is needed here.
 *
 * This whole construct is **context-gated** by the caller (it is only
 * instantiated when the gateway feature flag is set), so the default CDK synth
 * stays byte-for-byte unchanged and no new CFN types enter the bootstrap
 * policy's coverage set.
 */
export class ToolGateway extends Construct {
  /** The federating Gateway. */
  public readonly gateway: agentcore.Gateway;

  /** Lambda backing the ``abca_repo_config`` tool. */
  public readonly repoConfigFn: lambda.NodejsFunction;

  constructor(scope: Construct, id: string, props: ToolGatewayProps) {
    super(scope, id);

    const handlersDir = path.join(__dirname, '..', 'handlers');

    // --- Tool-backing Lambda: abca_repo_config (RepoTable GetItem) ---
    this.repoConfigFn = new lambda.NodejsFunction(this, 'RepoConfigFn', {
      entry: path.join(handlersDir, 'tool-repo-config.ts'),
      handler: 'handler',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(10),
      // A single GetItem — 256 MB is ample.
      memorySize: 256,
      environment: {
        REPO_TABLE_NAME: props.repoTable.tableName,
        // Solution UA attribution (#319): stable per-component md/ label.
        ABCA_COMPONENT: 'gwtool',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Read-only: the tool only ever GetItems the repo's config row.
    props.repoTable.grantReadData(this.repoConfigFn);

    // --- Gateway: AWS_IAM (SigV4) inbound ---
    this.gateway = new agentcore.Gateway(this, 'Gateway', {
      authorizerConfiguration: agentcore.GatewayAuthorizer.usingAwsIam(),
      description: 'ABCA agent tool federation (ADR-019). SigV4 inbound; gateway-role outbound.',
    });

    // --- Lambda target: abca_repo_config ---
    // Outbound credential provider defaults to fromIamRole() (GATEWAY_IAM_ROLE);
    // the bind auto-grants the gateway role invoke on repoConfigFn.
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

    // grantReadData → dynamodb:GetItem/Query/... on the table AND index/* ARNs.
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
   *
   * The L2 types ``Gateway.gatewayUrl`` as ``string | undefined``. Rather than
   * a ``!`` non-null assertion at each call site — which would silently ship
   * the literal string ``"undefined"`` into the env if the L2 ever returns
   * undefined — resolve it once here and fail synth loudly instead.
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
