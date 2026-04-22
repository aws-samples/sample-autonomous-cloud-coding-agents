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
import { StrandedTaskReconciler } from '../constructs/stranded-task-reconciler';
import { DnsFirewall } from '../constructs/dns-firewall';
// import { EcsAgentCluster } from '../constructs/ecs-agent-cluster';
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

    // Two separate AssetImage instances — one per runtime. The L2 construct
    // grants ECR pull inside ``AssetImage.bind``, but guards the grant with a
    // ``this.bound`` flag (see the copy of the construct under
    // ``node_modules/@aws-cdk/aws-bedrock-agentcore-alpha/lib/runtime/
    // runtime-artifact.js`` — ``AssetImage.bind`` sets ``this.bound = true``
    // after the first ``grantPull``, so subsequent ``bind()`` calls are
    // skipped entirely). When the SAME instance is passed to two Runtimes,
    // the second runtime's execution role never receives ECR permissions →
    // image pull fails with 424 "no basic auth credentials" on /invocations.
    //
    // The DockerImageAsset dedupes on asset hash so we still publish one
    // image to ECR. Keep this split until the L2 fixes the multi-runtime
    // bind guard. Tracking follow-up: ``docs/design/PHASE_1B_REV5_FOLLOWUPS.md``
    // → CDK-1 (file an upstream issue against
    // ``@aws-cdk/aws-bedrock-agentcore-alpha``).
    const artifactIam = agentcore.AgentRuntimeArtifact.fromAsset(runnerPath);
    const artifactJwt = agentcore.AgentRuntimeArtifact.fromAsset(runnerPath);

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

    // --- Runtime-JWT needs the Cognito User Pool + App Client owned by TaskApi.
    // TaskApi in turn needs the orchestrator ARN (not yet available). We break
    // the cycle with Lazy strings: TaskApi is constructed first with lazy refs
    // to the orchestrator alias ARN, which is set once the orchestrator exists.
    // At synth time the Lazy resolves to a CloudFormation token — no runtime
    // ordering issue because the stack deploys both resources together.
    let orchestratorArnHolder: string | undefined;
    const lazyOrchestratorArn = Lazy.string({
      produce: () => {
        if (!orchestratorArnHolder) {
          throw new Error('Orchestrator ARN was accessed before the TaskOrchestrator was created');
        }
        return orchestratorArnHolder;
      },
    });

    // Two Runtime ARN placeholders — the runtimes are created AFTER TaskApi
    // because Runtime-JWT needs the Cognito pool owned by TaskApi.
    let runtimeIamArnHolder: string | undefined;
    const lazyRuntimeIamArn = Lazy.string({
      produce: () => {
        if (!runtimeIamArnHolder) {
          throw new Error('Runtime-IAM ARN was accessed before RuntimeIam was created');
        }
        return runtimeIamArnHolder;
      },
    });
    let runtimeJwtArnHolder: string | undefined;
    const lazyRuntimeJwtArn = Lazy.string({
      produce: () => {
        if (!runtimeJwtArnHolder) {
          throw new Error('Runtime-JWT ARN was accessed before RuntimeJwt was created');
        }
        return runtimeJwtArnHolder;
      },
    });

    // --- Task API (REST API + Cognito + Lambda handlers) ---
    // Created early so the Cognito User Pool is available for Runtime-JWT below.
    const taskApi = new TaskApi(this, 'TaskApi', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      repoTable: repoTable.table,
      webhookTable: webhookTable.table,
      orchestratorFunctionArn: lazyOrchestratorArn,
      guardrailId: inputGuardrail.guardrailId,
      guardrailVersion: inputGuardrail.guardrailVersion,
      agentCoreStopSessionRuntimeArns: [lazyRuntimeIamArn, lazyRuntimeJwtArn],
    });

    // --- Two AgentCore Runtimes (same artifact, different authorizer) ---
    //
    // Runtime-IAM: invoked by the OrchestratorFn Lambda via SigV4.
    // Runtime-JWT: invoked directly by CLI/SPA clients with a Cognito ID token.
    //
    // Sessions are scoped to a single runtime ARN (cannot be transferred across
    // runtimes) but ProgressWriter writes to TaskEventsTable from inside the
    // container regardless of invocation path, so cross-path observation works.
    //
    // Both runtimes share the same execution role requirements, VPC, secrets,
    // memory, models, and env vars — factor them into shared constants first.
    const runtimeEnvironmentVariables = {
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
    };

    const runtimeNetworkConfig = agentcore.RuntimeNetworkConfiguration.usingVpc(this, {
      vpc: agentVpc.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [agentVpc.runtimeSecurityGroup],
    });

    // LifecycleConfiguration — see design doc §9.12.
    // Defaults (idle=900s, max=28800s) are too aggressive: a 15-minute idle
    // window will recycle the microVM while a user is reconnecting, losing the
    // session. Raise idle to match maxLifetime (both capped at 8h by the
    // AgentCore service quota). maxLifetime remains 8h (service maximum).
    const sharedLifecycleConfiguration: agentcore.LifecycleConfiguration = {
      idleRuntimeSessionTimeout: Duration.hours(8),
      maxLifetime: Duration.hours(8),
    };

    // --- Runtime-IAM (orchestrator path) ---
    // Uses default IAM authorizer. Consumed by OrchestratorFn.
    //
    // Construct id kept as 'Runtime' (not renamed to 'RuntimeIam') so CFN
    // updates the existing deployed resource in place. Renaming would force
    // CFN to CREATE a new AgentCore Runtime before DELETING the old one —
    // both carrying runtimeName 'jean_cloude', which violates AgentCore's
    // account-level name uniqueness and triggers an UPDATE_ROLLBACK. The TS
    // variable name `runtimeIam` documents its Phase 1b role.
    const runtimeIam = new agentcore.Runtime(this, 'Runtime', {
      runtimeName,
      agentRuntimeArtifact: artifactIam,
      networkConfiguration: runtimeNetworkConfig,
      environmentVariables: runtimeEnvironmentVariables,
      lifecycleConfiguration: sharedLifecycleConfiguration,
    });

    // --- Runtime-JWT (interactive CLI/SPA path) ---
    // Uses Cognito User Pool JWT authorizer. Consumed directly by clients over
    // streaming InvokeAgentRuntime (SSE). Phase 1b direct-to-AgentCore path.
    //
    // Runtime name must match the AgentCore pattern ^[a-zA-Z][a-zA-Z0-9_]{0,47}$
    // and must be globally unique per-runtime within the account/region.
    const runtimeJwtName = `${runtimeName}_jwt`;
    const runtimeJwt = new agentcore.Runtime(this, 'RuntimeJwt', {
      runtimeName: runtimeJwtName,
      agentRuntimeArtifact: artifactJwt,
      networkConfiguration: runtimeNetworkConfig,
      environmentVariables: runtimeEnvironmentVariables,
      lifecycleConfiguration: sharedLifecycleConfiguration,
      authorizerConfiguration: agentcore.RuntimeAuthorizerConfiguration.usingCognito(
        taskApi.userPool,
        [taskApi.appClient],
      ),
    });

    runtimeIamArnHolder = runtimeIam.agentRuntimeArn;
    runtimeJwtArnHolder = runtimeJwt.agentRuntimeArn;

    // --- Session storage (preview) on BOTH runtimes ---
    // The L2 construct does not yet expose filesystemConfigurations; use the
    // CFN escape hatch. Same /mnt/workspace mount on both runtimes so an
    // interactive task can share the persistent cache with orchestrator-path
    // tasks in the same repo.
    for (const rt of [runtimeIam, runtimeJwt]) {
      const cfnRuntime = rt.node.defaultChild as CfnResource;
      cfnRuntime.addPropertyOverride('FilesystemConfigurations', [
        {
          SessionStorage: {
            MountPath: '/mnt/workspace',
          },
        },
      ]);
    }

    // --- Rev-5 OBS-4 note: no runtime-self-ARN env var ---
    // An earlier attempt injected each runtime's own ARN as an env var
    // so `server.py` could write it to TaskTable. That creates a CFN
    // cycle (Runtime property references the same Runtime's
    // `AgentRuntimeArn` GetAtt). The interactive path instead records
    // only `session_id` on TaskTable from server.py; the cancel-task
    // Lambda resolves the correct runtime ARN by consulting
    // `execution_mode` on the task record (RUNTIME_IAM_ARN for
    // orchestrator, RUNTIME_JWT_ARN for interactive) — both ARNs are
    // known to the cancel-task Lambda at CDK synth time with no cycle.

    // --- Shared IAM grants on BOTH runtimes ---
    for (const rt of [runtimeIam, runtimeJwt]) {
      taskTable.table.grantReadWriteData(rt);
      taskEventsTable.table.grantReadWriteData(rt);
      userConcurrencyTable.table.grantReadWriteData(rt);
      githubTokenSecret.grantRead(rt);
      applicationLogGroup.grantWrite(rt);
      agentMemory.grantReadWrite(rt);
    }

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

    for (const rt of [runtimeIam, runtimeJwt]) {
      model.grantInvoke(rt);
      inferenceProfile.grantInvoke(rt);
      model3.grantInvoke(rt);
      inferenceProfile3.grantInvoke(rt);
      model2.grantInvoke(rt);
      inferenceProfile2.grantInvoke(rt);

      // Runtime logs and traces (same config for both)
      rt.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.APPLICATION_LOGS.toLogGroup(applicationLogGroup));
      rt.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.TRACES.toXRay());
      rt.with(agentcoremixins.mixins.CfnRuntimeLogsMixin.USAGE_LOGS.toLogGroup(usageLogGroup));

      NagSuppressions.addResourceSuppressions(rt, [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'AgentCore runtime requires wildcard permissions for CloudWatch Logs, Bedrock model invocation, and cross-region inference profiles — generated by CDK L2 construct grants',
        },
      ], true);
    }

    new CfnOutput(this, 'RuntimeIamArn', {
      value: runtimeIam.agentRuntimeArn,
      description: 'ARN of the AgentCore runtime with IAM authorizer (orchestrator path)',
    });

    new CfnOutput(this, 'RuntimeJwtArn', {
      value: runtimeJwt.agentRuntimeArn,
      description: 'ARN of the AgentCore runtime with Cognito JWT authorizer (interactive CLI/SPA path)',
    });

    // Backward-compatible alias — existing consumers (dashboards, scripts) that
    // previously read `RuntimeArn` continue to work; defaults to Runtime-IAM.
    new CfnOutput(this, 'RuntimeArn', {
      value: runtimeIam.agentRuntimeArn,
      description: 'Deprecated alias for RuntimeIamArn — the IAM-auth runtime ARN',
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
    // runtimeArn points to Runtime-IAM only — the orchestrator must NOT invoke
    // Runtime-JWT (which requires a Cognito ID token from a real user).
    const orchestrator = new TaskOrchestrator(this, 'TaskOrchestrator', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
      repoTable: repoTable.table,
      runtimeArn: runtimeIam.agentRuntimeArn,
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

    // --- Stranded-task reconciler (rev-5 P0-c) ---
    // Fails SUBMITTED / HYDRATING tasks whose pipeline never started.
    // Complements the `bgagent run` client-side cancel on SSE fatal by
    // catching the CLI-dead edge case (kill -9, network partition, or
    // orchestrator Lambda crash).
    new StrandedTaskReconciler(this, 'StrandedTaskReconciler', {
      taskTable: taskTable.table,
      taskEventsTable: taskEventsTable.table,
      userConcurrencyTable: userConcurrencyTable.table,
    });

    // --- Operator dashboard ---
    // Dashboards the orchestrator-path runtime (Runtime-IAM). Runtime-JWT
    // metrics can be added in a later phase when interactive telemetry matures.
    new TaskDashboard(this, 'TaskDashboard', {
      applicationLogGroup,
      runtimeArn: runtimeIam.agentRuntimeArn,
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
