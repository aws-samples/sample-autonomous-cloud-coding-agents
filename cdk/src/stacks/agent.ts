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
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as bedrock from '@aws-cdk/aws-bedrock-alpha';
import * as agentcoremixins from '@aws-cdk/mixins-preview/aws-bedrockagentcore';
import { Stack, StackProps, RemovalPolicy, CfnOutput, CfnResource } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { AgentMemory } from '../constructs/agent-memory';
import { AgentVpc } from '../constructs/agent-vpc';
import { Blueprint } from '../constructs/blueprint';
import { ConcurrencyReconciler } from '../constructs/concurrency-reconciler';
import { DnsFirewall } from '../constructs/dns-firewall';
import { EcsAgentCluster } from '../constructs/ecs-agent-cluster';
import { RepoTable } from '../constructs/repo-table';
import { TaskApi } from '../constructs/task-api';
import { TaskDashboard } from '../constructs/task-dashboard';
import { TaskEventsTable } from '../constructs/task-events-table';
import { TaskOrchestrator } from '../constructs/task-orchestrator';
import { TaskTable } from '../constructs/task-table';
import { UserConcurrencyTable } from '../constructs/user-concurrency-table';
import { WebhookTable } from '../constructs/webhook-table';

export class AgentStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps = {}) {
    super(scope, id, props);

    const runnerPath = path.join(__dirname, '..', '..', '..', 'agent');

    const artifact = agentcore.AgentRuntimeArtifact.fromAsset(runnerPath);

    // Task state persistence
    const taskTable = new TaskTable(this, 'TaskTable');
    const taskEventsTable = new TaskEventsTable(this, 'TaskEventsTable');
    const userConcurrencyTable = new UserConcurrencyTable(this, 'UserConcurrencyTable');
    const webhookTable = new WebhookTable(this, 'WebhookTable');
    const repoTable = new RepoTable(this, 'RepoTable');

    // --- Repository onboarding ---
    const agentPluginsBlueprint = new Blueprint(this, 'AgentPluginsBlueprint', {
      repo: 'krokoko/agent-plugins',
      repoTable: repoTable.table,
    });

    const blueprints = [agentPluginsBlueprint];

    // The AwsCustomResource singleton Lambda used by Blueprint constructs
    NagSuppressions.addResourceSuppressionsByPath(this, [
      `${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/ServiceRole/Resource`,
      `${this.stackName}/AWS679f53fac002430cb0da5b7982bd2287/Resource`,
    ], [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AwsCustomResource singleton Lambda uses AWS managed AWSLambdaBasicExecutionRole — required by CDK custom-resources framework',
      },
      {
        id: 'AwsSolutions-L1',
        reason: 'AwsCustomResource singleton Lambda runtime is managed by the CDK custom-resources framework',
      },
    ]);

    const runtimeName = 'jean_cloude';

    // Log groups (created before runtime so we can reference the name in env vars)
    const applicationLogGroup = new logs.LogGroup(this, 'RuntimeApplicationLogGroup', {
      logGroupName: `/aws/vendedlogs/bedrock-agentcore/runtime/APPLICATION_LOGS/${runtimeName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const usageLogGroup = new logs.LogGroup(this, 'RuntimeUsageLogGroup', {
      logGroupName: `/aws/vendedlogs/bedrock-agentcore/runtime/USAGE_LOGS/${runtimeName}`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // GitHub token stored in Secrets Manager — agent fetches at startup via ARN
    const githubTokenSecret = new secretsmanager.Secret(this, 'GitHubTokenSecret', {
      description: 'GitHub personal access token for the background agent',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    NagSuppressions.addResourceSuppressions(githubTokenSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'GitHub PAT is managed externally — automatic rotation is not applicable',
      },
    ]);

    // Network isolation — VPC with restricted egress
    const agentVpc = new AgentVpc(this, 'AgentVpc');

    // DNS Firewall — domain-level egress filtering (observation mode for initial deployment)
    const additionalDomains = [...new Set(blueprints.flatMap(b => b.egressAllowlist))];
    new DnsFirewall(this, 'DnsFirewall', {
      vpc: agentVpc.vpc,
      additionalAllowedDomains: additionalDomains,
      observationMode: true,
    });

    // --- AgentCore Memory (cross-task learning) ---
    const agentMemory = new AgentMemory(this, 'AgentMemory');

    const runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName,
      agentRuntimeArtifact: artifact,
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
        vpc: agentVpc.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [agentVpc.runtimeSecurityGroup],
      }),
      environmentVariables: {
        GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
        AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_LOG: 'debug',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        TASK_TABLE_NAME: taskTable.table.tableName,
        TASK_EVENTS_TABLE_NAME: taskEventsTable.table.tableName,
        USER_CONCURRENCY_TABLE_NAME: userConcurrencyTable.table.tableName,
        LOG_GROUP_NAME: applicationLogGroup.logGroupName,
        MEMORY_ID: agentMemory.memory.memoryId,
        MAX_TURNS: '100',
        // Session storage: the S3-backed FUSE mount at /mnt/workspace does NOT
        // support flock(). Only caches whose tools never call flock() go there.
        // Everything else stays on local ephemeral disk.
        //
        // Local disk (tools use flock):
        //   AGENT_WORKSPACE — omitted, defaults to /workspace
        //   MISE_DATA_DIR — mise's pipx backend sets UV_TOOL_DIR inside installs/,
        //     and uv flocks that directory → must be local.
        MISE_DATA_DIR: '/tmp/mise-data',
        UV_CACHE_DIR: '/tmp/uv-cache',
        // Persistent mount (no flock):
        CLAUDE_CONFIG_DIR: '/mnt/workspace/.claude-config',
        npm_config_cache: '/mnt/workspace/.npm-cache',
        // ENABLE_CLI_TELEMETRY: '1',
      },
    });

    // --- Session storage (preview) ---
    // The L2 construct does not yet expose filesystemConfigurations.
    // Use a CFN escape hatch until the L2 adds native support.
    const cfnRuntime = runtime.node.defaultChild as CfnResource;
    cfnRuntime.addPropertyOverride('FilesystemConfigurations', [
      {
        SessionStorage: {
          MountPath: '/mnt/workspace',
        },
      },
    ]);

    taskTable.table.grantReadWriteData(runtime);
    taskEventsTable.table.grantReadWriteData(runtime);
    userConcurrencyTable.table.grantReadWriteData(runtime);
    githubTokenSecret.grantRead(runtime);
    applicationLogGroup.grantWrite(runtime);
    agentMemory.grantReadWrite(runtime);

    const model = new bedrock.BedrockFoundationModel('anthropic.claude-sonnet-4-6', {
      supportsAgents: true,
      supportsCrossRegion: true,
    });

    model.grantInvoke(runtime);

    // Create a cross-region inference profile for Claude Sonnet 4.6
    const inferenceProfile = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: model,
    });

    // Grant the runtime permissions to invoke the inference profile
    inferenceProfile.grantInvoke(runtime);

    const model2 = new bedrock.BedrockFoundationModel('anthropic.claude-haiku-4-5-20251001-v1:0', {
      supportsAgents: true,
      supportsCrossRegion: true,
    });

    model2.grantInvoke(runtime);

    // Create a cross-region inference profile for Claude Haiku 4.5
    const inferenceProfile2 = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: model2,
    });

    // Grant the runtime permissions to invoke the inference profile
    inferenceProfile2.grantInvoke(runtime);

    // Runtime logs and traces
    runtime.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.APPLICATION_LOGS.toLogGroup(applicationLogGroup));
    runtime.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.TRACES.toXRay());
    runtime.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.USAGE_LOGS.toLogGroup(usageLogGroup));

    NagSuppressions.addResourceSuppressions(runtime, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'AgentCore runtime requires wildcard permissions for CloudWatch Logs, Bedrock model invocation, and cross-region inference profiles — generated by CDK L2 construct grants',
      },
    ], true);

    new CfnOutput(this, 'RuntimeArn', {
      value: runtime.agentRuntimeArn,
      description: 'ARN of the AgentCore runtime',
    });

    new CfnOutput(this, 'TaskTableName', {
      value: taskTable.table.tableName,
      description: 'Name of the DynamoDB task state table',
    });

    new CfnOutput(this, 'TaskEventsTableName', {
      value: taskEventsTable.table.tableName,
      description: 'Name of the DynamoDB task events audit table',
    });

    new CfnOutput(this, 'UserConcurrencyTableName', {
      value: userConcurrencyTable.table.tableName,
      description: 'Name of the DynamoDB user concurrency table',
    });

    new CfnOutput(this, 'WebhookTableName', {
      value: webhookTable.table.tableName,
      description: 'Name of the DynamoDB webhook table',
    });

    new CfnOutput(this, 'RepoTableName', {
      value: repoTable.table.tableName,
      description: 'Name of the DynamoDB repo config table',
    });

    new CfnOutput(this, 'GitHubTokenSecretArn', {
      value: githubTokenSecret.secretArn,
      description: 'ARN of the Secrets Manager secret for the GitHub token',
    });

    // --- Bedrock Guardrail for prompt injection detection ---
    const inputGuardrail = new bedrock.Guardrail(this, 'InputGuardrail', {
      guardrailName: 'task-input-guardrail',
      description: 'Screens task submissions for prompt injection attacks',
      contentFilters: [
        {
          type: bedrock.ContentFilterType.PROMPT_ATTACK,
          inputStrength: bedrock.ContentFilterStrength.HIGH,
          outputStrength: bedrock.ContentFilterStrength.NONE,
        },
      ],
    });

    inputGuardrail.createVersion('Initial version');

    // --- ECS Fargate compute backend (conditional) ---
    // ECS infrastructure is opt-in via the ABCA_ENABLE_ECS env flag.
    // Repos can then use compute_type: 'ecs' in their blueprint config.
    const needsEcs = process.env.ABCA_ENABLE_ECS === 'true';

    let ecsCluster: EcsAgentCluster | undefined;
    if (needsEcs) {
      const agentImageAsset = new ecr_assets.DockerImageAsset(this, 'AgentImage', {
        directory: runnerPath,
        platform: ecr_assets.Platform.LINUX_ARM64,
      });

      ecsCluster = new EcsAgentCluster(this, 'EcsAgentCluster', {
        vpc: agentVpc.vpc,
        agentImageAsset,
        taskTable: taskTable.table,
        taskEventsTable: taskEventsTable.table,
        userConcurrencyTable: userConcurrencyTable.table,
        githubTokenSecret,
        memoryId: agentMemory.memory.memoryId,
      });
    }

    // --- Task Orchestrator (durable Lambda function) ---
    const orchestrator = new TaskOrchestrator(this, 'TaskOrchestrator', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      repoTable: repoTable.table,
      runtimeArn: runtime.agentRuntimeArn,
      githubTokenSecretArn: githubTokenSecret.secretArn,
      memoryId: agentMemory.memory.memoryId,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      ...(ecsCluster && {
        ecsClusterArn: ecsCluster.cluster.clusterArn,
        ecsTaskDefinitionArn: ecsCluster.taskDefinition.taskDefinitionArn,
        ecsSubnets: agentVpc.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
        ecsSecurityGroup: ecsCluster.securityGroup.securityGroupId,
        ecsContainerName: ecsCluster.containerName,
        ecsTaskRoleArn: ecsCluster.taskRoleArn,
        ecsExecutionRoleArn: ecsCluster.executionRoleArn,
      }),
    });

    // Grant the orchestrator Lambda read+write access to memory
    // (reads during context hydration, writes for fallback episodes)
    agentMemory.grantReadWrite(orchestrator.fn);

    // --- Concurrency counter reconciler (drift correction) ---
    new ConcurrencyReconciler(this, 'ConcurrencyReconciler', {
      taskTable: taskTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    // --- Task API (REST API + Cognito + Lambda handlers) ---
    const taskApi = new TaskApi(this, 'TaskApi', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      repoTable: repoTable.table,
      webhookTable: webhookTable.table,
      orchestratorFunctionArn: orchestrator.alias.functionArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      agentCoreStopSessionRuntimeArns: [runtime.agentRuntimeArn],
    });

    // --- Operator dashboard ---
    new TaskDashboard(this, 'TaskDashboard', {
      applicationLogGroup,
      runtimeArn: runtime.agentRuntimeArn,
    });

    // --- Bedrock model invocation logging (account-level) ---
    const invocationLogGroup = new logs.LogGroup(this, 'ModelInvocationLogGroup', {
      logGroupName: '/aws/bedrock/model-invocation-logs',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const bedrockLoggingRole = new iam.Role(this, 'BedrockLoggingRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
    });
    invocationLogGroup.grantWrite(bedrockLoggingRole);

    // Bedrock model invocation logging is a non-critical observability feature.
    // ignoreErrorCodesMatching prevents a Bedrock API error from rolling back
    // the entire stack deployment.
    const invocationLogging = new cr.AwsCustomResource(this, 'ModelInvocationLogging', {
      onCreate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: invocationLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
              // Required by API schema but unused — text logs go to CloudWatch only.
              largeDataDeliveryS3Config: { bucketName: '', keyPrefix: '' },
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
        ignoreErrorCodesMatching: '.*',
      },
      // onUpdate re-applies the same config to handle drift (e.g., if another
      // stack or manual action changed the account-level logging config).
      onUpdate: {
        service: 'Bedrock',
        action: 'putModelInvocationLoggingConfiguration',
        parameters: {
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: invocationLogGroup.logGroupName,
              roleArn: bedrockLoggingRole.roleArn,
              largeDataDeliveryS3Config: { bucketName: '', keyPrefix: '' },
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of('bedrock-invocation-logging'),
        ignoreErrorCodesMatching: '.*',
      },
      onDelete: {
        service: 'Bedrock',
        action: 'deleteModelInvocationLoggingConfiguration',
        parameters: {},
        ignoreErrorCodesMatching: '.*',
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
      ]),
    });

    NagSuppressions.addResourceSuppressions(invocationLogging, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Bedrock model invocation logging configuration APIs are account-level and do not support resource-level permissions',
      },
    ], true);

    NagSuppressions.addResourceSuppressions(bedrockLoggingRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'CloudWatch Logs grantWrite generates wildcards for log stream creation — required by Bedrock logging service',
      },
    ], true);

    new CfnOutput(this, 'ApiUrl', {
      value: taskApi.api.url,
      description: 'URL of the Task API',
    });

    new CfnOutput(this, 'UserPoolId', {
      value: taskApi.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new CfnOutput(this, 'AppClientId', {
      value: taskApi.appClientId,
      description: 'Cognito App Client ID',
    });
  }
}
