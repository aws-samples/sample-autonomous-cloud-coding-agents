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
import { Stack, StackProps, RemovalPolicy, CfnOutput, CfnResource, Duration, Lazy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
// ecr_assets import is only needed when the ECS block below is uncommented
// import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
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
import { FanOutConsumer } from '../constructs/fanout-consumer';
import { RepoTable } from '../constructs/repo-table';
import { StrandedTaskReconciler } from '../constructs/stranded-task-reconciler';
// import { EcsAgentCluster } from '../constructs/ecs-agent-cluster';
import { TaskApi } from '../constructs/task-api';
import { TaskDashboard } from '../constructs/task-dashboard';
import { TaskEventsTable } from '../constructs/task-events-table';
import { TaskNudgesTable } from '../constructs/task-nudges-table';
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
    const taskNudgesTable = new TaskNudgesTable(this, 'TaskNudgesTable');
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

    // --- Bedrock Guardrail for prompt injection detection ---
    // (Declared early so TaskApi — constructed before the runtimes — can reference it.)
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

    // --- TaskApi is constructed before the orchestrator (which it needs the
    // ARN of) and before the Runtime (which it needs the ARN of, for the
    // cancel-task Lambda's stop-session permission). We break both cycles
    // with Lazy strings that resolve to CloudFormation tokens at synth time.
    let orchestratorArnHolder: string | undefined;
    const lazyOrchestratorArn = Lazy.string({
      produce: () => {
        if (!orchestratorArnHolder) {
          throw new Error('Orchestrator ARN was accessed before the TaskOrchestrator was created');
        }
        return orchestratorArnHolder;
      },
    });

    // Runtime ARN placeholder — the runtime is created AFTER TaskApi so the
    // Lambda handlers can get their env var via a Lazy.string reference.
    let runtimeArnHolder: string | undefined;
    const lazyRuntimeArn = Lazy.string({
      produce: () => {
        if (!runtimeArnHolder) {
          throw new Error('Runtime ARN was accessed before Runtime was created');
        }
        return runtimeArnHolder;
      },
    });

    // --- Task API (REST API + Cognito + Lambda handlers) ---
    const taskApi = new TaskApi(this, 'TaskApi', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      taskNudgesTable: taskNudgesTable.table,
      repoTable: repoTable.table,
      webhookTable: webhookTable.table,
      orchestratorFunctionArn: lazyOrchestratorArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      agentCoreStopSessionRuntimeArn: lazyRuntimeArn,
    });

    // --- AgentCore Runtime (IAM-authed orchestrator path) ---
    //
    // One runtime, invoked by OrchestratorFn via SigV4. See
    // `docs/design/INTERACTIVE_AGENTS.md` §3.1 and AD-1.
    const runtimeEnvironmentVariables = {
      GITHUB_TOKEN_SECRET_ARN: githubTokenSecret.secretArn,
      AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_LOG: 'debug',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      TASK_TABLE_NAME: taskTable.table.tableName,
      TASK_EVENTS_TABLE_NAME: taskEventsTable.table.tableName,
      NUDGES_TABLE_NAME: taskNudgesTable.table.tableName,
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
    };

    const runtimeNetworkConfig = agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
      vpc: agentVpc.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [agentVpc.runtimeSecurityGroup],
    });

    // LifecycleConfiguration — both timers set to the AgentCore 8h maximum so
    // long-running tasks (approval waits, heavy builds) are not evicted.
    const lifecycleConfiguration: agentcore.LifecycleConfiguration = {
      idleRuntimeSessionTimeout: Duration.hours(8),
      maxLifetime: Duration.hours(8),
    };

    // Construct id 'Runtime' is load-bearing — renaming it forces CFN to
    // CREATE the new resource before DELETING the old one, violating
    // AgentCore's account-level runtimeName uniqueness and triggering an
    // UPDATE_ROLLBACK.
    const runtime = new agentcore.Runtime(this, 'Runtime', {
      runtimeName,
      agentRuntimeArtifact: artifact,
      networkConfiguration: runtimeNetworkConfig,
      environmentVariables: runtimeEnvironmentVariables,
      lifecycleConfiguration: lifecycleConfiguration,
    });

    runtimeArnHolder = runtime.agentRuntimeArn;

    // --- Session storage (preview) ---
    // The L2 construct does not yet expose filesystemConfigurations; use the
    // CFN escape hatch. /mnt/workspace mount backs the persistent cache
    // shared across tasks in the same repo.
    const cfnRuntime = runtime.node.defaultChild as CfnResource;
    cfnRuntime.addPropertyOverride('FilesystemConfigurations', [
      {
        SessionStorage: {
          MountPath: '/mnt/workspace',
        },
      },
    ]);

    // --- IAM grants ---
    taskTable.table.grantReadWriteData(runtime);
    taskEventsTable.table.grantReadWriteData(runtime);
    taskNudgesTable.table.grantReadWriteData(runtime);
    userConcurrencyTable.table.grantReadWriteData(runtime);
    githubTokenSecret.grantRead(runtime);
    applicationLogGroup.grantWrite(runtime);
    agentMemory.grantReadWrite(runtime);

    const model = new bedrock.BedrockFoundationModel('anthropic.claude-sonnet-4-6', {
      supportsAgents: true,
      supportsCrossRegion: true,
    });

    // Create a cross-region inference profile for Claude Sonnet 4.6
    const inferenceProfile = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: model,
    });

    const model3 = new bedrock.BedrockFoundationModel('anthropic.claude-opus-4-20250514-v1:0', {
      supportsAgents: true,
      supportsCrossRegion: true,
    });

    const inferenceProfile3 = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: model3,
    });

    const model2 = new bedrock.BedrockFoundationModel('anthropic.claude-haiku-4-5-20251001-v1:0', {
      supportsAgents: true,
      supportsCrossRegion: true,
    });

    // Create a cross-region inference profile for Claude Haiku 4.5
    const inferenceProfile2 = bedrock.CrossRegionInferenceProfile.fromConfig({
      geoRegion: bedrock.CrossRegionInferenceProfileRegion.US,
      model: model2,
    });

    model.grantInvoke(runtime);
    inferenceProfile.grantInvoke(runtime);
    model3.grantInvoke(runtime);
    inferenceProfile3.grantInvoke(runtime);
    model2.grantInvoke(runtime);
    inferenceProfile2.grantInvoke(runtime);

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

    new CfnOutput(this, 'TaskNudgesTableName', {
      value: taskNudgesTable.table.tableName,
      description: 'Name of the DynamoDB task nudges table (Phase 2)',
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

    // --- ECS Fargate compute backend (optional) ---
    // To enable ECS as an alternative compute backend, uncomment the block below
    // and the EcsAgentCluster import at the top of this file. Repos can then use
    // compute_type: 'ecs' in their blueprint config to route tasks to ECS Fargate.
    //
    // const agentImageAsset = new ecr_assets.DockerImageAsset(this, 'AgentImage', {
    //   directory: runnerPath,
    //   platform: ecr_assets.Platform.LINUX_ARM64,
    // });
    //
    // const ecsCluster = new EcsAgentCluster(this, 'EcsAgentCluster', {
    //   vpc: agentVpc.vpc,
    //   agentImageAsset,
    //   taskTable: taskTable.table,
    //   taskEventsTable: taskEventsTable.table,
    //   userConcurrencyTable: userConcurrencyTable.table,
    //   githubTokenSecret,
    //   memoryId: agentMemory.memory.memoryId,
    // });

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
      // To wire ECS, uncomment the ecsCluster block above and add:
      // ecsConfig: {
      //   clusterArn: ecsCluster.cluster.clusterArn,
      //   taskDefinitionArn: ecsCluster.taskDefinition.taskDefinitionArn,
      //   subnets: agentVpc.vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
      //   securityGroup: ecsCluster.securityGroup.securityGroupId,
      //   containerName: ecsCluster.containerName,
      //   taskRoleArn: ecsCluster.taskRoleArn,
      //   executionRoleArn: ecsCluster.executionRoleArn,
      // },
    });

    // Now that the orchestrator exists, resolve the Lazy used by TaskApi at synth.
    orchestratorArnHolder = orchestrator.alias.functionArn;

    // Grant the orchestrator Lambda read+write access to memory
    // (reads during context hydration, writes for fallback episodes)
    agentMemory.grantReadWrite(orchestrator.fn);

    // --- Concurrency counter reconciler (drift correction) ---
    new ConcurrencyReconciler(this, 'ConcurrencyReconciler', {
      taskTable: taskTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    // --- Stranded-task reconciler ---
    // Catches SUBMITTED / HYDRATING tasks whose pipeline never started
    // (orchestrator Lambda crash between TaskTable write and InvokeAgentRuntime,
    // container crash during startup, etc.). Transitions to FAILED with a
    // `task_stranded` event.
    new StrandedTaskReconciler(this, 'StrandedTaskReconciler', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    // --- Fan-out plane consumer ---
    // Consumes TaskEventsTable DynamoDB Streams and dispatches events to
    // Slack / GitHub / email per per-channel default filters. Ships as a
    // router with log-only dispatchers; real integrations land incrementally.
    new FanOutConsumer(this, 'FanOutConsumer', {
      taskEventsTable: taskEventsTable.table,
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
