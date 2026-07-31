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
import * as lambdaMicrovmCompute from '../../src/constructs/lambda-microvm-compute';
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

  test('creates exactly 18 DynamoDB tables', () => {
    // task, task-events, repo, user-concurrency, webhook, task-nudges,
    // task-approvals (Cedar HITL V2),
    // api-key (platform API keys for headless webhook management, #376),
    // slack-installation, slack-user-mapping,
    // linear-project-mapping, linear-user-mapping, linear-webhook-dedup,
    // linear-workspace-registry (added in Phase 2.0b for OAuth bookkeeping),
    // jira-project-mapping, jira-user-mapping, jira-workspace-registry,
    // jira-webhook-dedup (added for the Jira Cloud integration),
    // github-webhook-dedup (added by GitHubScreenshotIntegration on main)
    template.resourceCountIs('AWS::DynamoDB::Table', 19);
  });

  test('creates TaskApprovalsTable with user_id-status-index GSI', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const approvalTables = Object.values(tables).filter((t) => {
      const ks = (t as { Properties?: { KeySchema?: Array<{ AttributeName: string }> } })
        .Properties?.KeySchema ?? [];
      return (
        ks.length === 2 && ks[0]!.AttributeName === 'task_id' && ks[1]!.AttributeName === 'request_id'
      );
    });
    expect(approvalTables).toHaveLength(1);
    const gsis = ((approvalTables[0] as { Properties?: { GlobalSecondaryIndexes?: Array<{ IndexName: string }> } })
      .Properties?.GlobalSecondaryIndexes ?? []) as Array<{ IndexName: string }>;
    expect(gsis.map((g) => g.IndexName)).toContain('user_id-status-index');
  });

  test('outputs TaskApprovalsTableName', () => {
    template.hasOutput('TaskApprovalsTableName', {
      Description: 'Name of the DynamoDB task approvals table (Cedar HITL)',
    });
  });

  test('outputs ComputeSubstrate=agentcore on the default (no-gate) deploy', () => {
    // The CLI reads this to refuse onboarding a repo as compute_type=ecs on a
    // stack that never provisioned the ECS substrate.
    template.hasOutput('ComputeSubstrate', { Value: 'agentcore' });
  });

  test('outputs CedarWasmLayerArn', () => {
    template.hasOutput('CedarWasmLayerArn', {});
  });

  test('creates the Cedar-wasm Lambda layer', () => {
    template.resourceCountIs('AWS::Lambda::LayerVersion', 1);
    template.hasResourceProperties('AWS::Lambda::LayerVersion', {
      CompatibleRuntimes: ['nodejs20.x', 'nodejs22.x', 'nodejs24.x'],
    });
  });

  test('runtime receives TASK_APPROVALS_TABLE_NAME env var', () => {
    // Hook contract: absent → task_state raises ApprovalTablesUnavailable
    // → hook fails closed. Test pins the env var is wired so the
    // deploy activates the approval path.
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const runtimeList = Object.values(runtimes);
    expect(runtimeList).toHaveLength(1);
    const envVars = (runtimeList[0] as {
      Properties?: { EnvironmentVariables?: Record<string, unknown> };
    }).Properties?.EnvironmentVariables ?? {};
    expect(envVars).toHaveProperty('TASK_APPROVALS_TABLE_NAME');
  });

  test('runtime receives AGENTCORE_MAX_LIFETIME_S matching the lifecycle config', () => {
    // Drift guard: hook's _remaining_maxlifetime_s reads this env var;
    // if it falls out of sync with `lifecycleConfiguration.maxLifetime`
    // the hook's clipping logic becomes wrong (too tight or too loose).
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const envVars = (Object.values(runtimes)[0] as {
      Properties?: { EnvironmentVariables?: Record<string, unknown> };
    }).Properties?.EnvironmentVariables ?? {};
    expect(envVars.AGENTCORE_MAX_LIFETIME_S).toBe('28800');
  });

  test('outputs TaskNudgesTableName', () => {
    template.hasOutput('TaskNudgesTableName', {
      Description: 'Name of the DynamoDB task nudges table (Phase 2)',
    });
  });

  test('creates TaskNudgesTable with task_id PK and nudge_id SK and no stream', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const nudgeTables = Object.values(tables).filter(t => {
      const ks = (t as { Properties?: { KeySchema?: Array<{ AttributeName: string }> } }).Properties?.KeySchema ?? [];
      return ks.length === 2 && ks[0]!.AttributeName === 'task_id' && ks[1]!.AttributeName === 'nudge_id';
    });
    expect(nudgeTables).toHaveLength(1);
    const props = (nudgeTables[0] as { Properties?: { StreamSpecification?: unknown } }).Properties ?? {};
    // No DynamoDB stream on nudges (poll-consumed).
    expect(props.StreamSpecification).toBeUndefined();
  });

  test('runtime receives NUDGES_TABLE_NAME env var', () => {
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const runtimeList = Object.values(runtimes);
    expect(runtimeList).toHaveLength(1);
    for (const rt of runtimeList) {
      const envVars = (rt as { Properties?: { EnvironmentVariables?: Record<string, unknown> } })
        .Properties?.EnvironmentVariables ?? {};
      expect(envVars).toHaveProperty('NUDGES_TABLE_NAME');
    }
  });

  test('default Haiku model env var is the cross-region inference profile (us.), not the bare model id', () => {
    // Claude 4.x on Bedrock cannot be invoked on-demand by bare foundation-model
    // id (400 "on-demand throughput isn't supported"); WebFetch's Haiku sub-calls
    // hit this. The env var must be the granted us.* inference profile.
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    for (const rt of Object.values(runtimes)) {
      const envVars = (rt as { Properties?: { EnvironmentVariables?: Record<string, unknown> } })
        .Properties?.EnvironmentVariables ?? {};
      expect(envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL)
        .toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    }
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
    template.hasOutput('RuntimeArn', {});
  });

  test('creates exactly one AgentCore Runtime', () => {
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);
  });

  test('runtime execution role carries ECR pull permissions', () => {
    const policies = template.findResources('AWS::IAM::Policy');

    const rolesWithEcrPull = Object.values(policies).filter(policy => {
      const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((s: { Action?: unknown }) => {
        const action = s.Action;
        const actions = Array.isArray(action) ? action : [action];
        return actions.includes('ecr:BatchGetImage')
          && actions.includes('ecr:GetDownloadUrlForLayer')
          && actions.includes('ecr:BatchCheckLayerAvailability');
      });
    });

    expect(rolesWithEcrPull.length).toBeGreaterThanOrEqual(1);
  });

  test('runtime has 8-hour lifecycle limits (idle + max)', () => {
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const runtimeList = Object.values(runtimes);
    expect(runtimeList).toHaveLength(1);
    for (const rt of runtimeList) {
      expect(rt.Properties?.LifecycleConfiguration).toEqual({
        IdleRuntimeSessionTimeout: 28800,
        MaxLifetime: 28800,
      });
    }
  });

  test('TaskEventsTable has DynamoDB Streams enabled with NEW_IMAGE', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'task_id', KeyType: 'HASH' },
        { AttributeName: 'event_id', KeyType: 'RANGE' },
      ],
      StreamSpecification: {
        StreamViewType: 'NEW_IMAGE',
      },
    });
  });

  test('orchestrator IAM policy grants InvokeAgentRuntime on the runtime', () => {
    // Find the orchestrator's IAM policy that contains InvokeAgentRuntime.
    const policies = template.findResources('AWS::IAM::Policy');
    const invokePolicies = Object.values(policies).filter(p => {
      const statements = p.Properties?.PolicyDocument?.Statement ?? [];
      return statements.some((s: { Action?: string | string[] }) => {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        return actions.includes('bedrock-agentcore:InvokeAgentRuntime');
      });
    });
    expect(invokePolicies.length).toBeGreaterThanOrEqual(1);

    // The policy must reference the runtime's ARN (via Fn::GetAtt on the
    // Runtime* logical id).
    const serialized = JSON.stringify(invokePolicies);
    expect(serialized).toMatch(/"Fn::GetAtt":\["Runtime[0-9A-F]+","AgentRuntimeArn"\]/);
  });

  test('runtime is granted the default Bedrock model set (#433)', () => {
    // Default (no bedrockModels context): the runtime execution role must hold
    // bedrock:InvokeModel on the three default foundation models + their US
    // inference profiles, scoped (never Resource: '*').
    const serialized = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(serialized).toContain('foundation-model/anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('anthropic.claude-opus-4-20250514-v1:0');
    expect(serialized).toContain('anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  test('bedrockModels context override propagates to the runtime execution role (#433)', () => {
    // The other half of #433's acceptance criteria (the ECS side is covered in
    // ecs-agent-cluster.test.ts): a context override must replace the runtime's
    // granted models too — overridden model present, defaults absent, still scoped.
    const app = new App({ context: { bedrockModels: ['anthropic.claude-opus-4-8'] } });
    const stack = new AgentStack(app, 'OverrideAgentStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const overridden = Template.fromStack(stack);

    // Collect every bedrock:InvokeModel statement's Resource across IAM policies.
    const policies = overridden.findResources('AWS::IAM::Policy');
    const bedrockResources: unknown[] = [];
    for (const p of Object.values(policies)) {
      for (const s of (p.Properties?.PolicyDocument?.Statement ?? []) as Array<{ Action?: string | string[]; Resource?: unknown }>) {
        const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
        if (actions.some((a) => typeof a === 'string' && a.startsWith('bedrock:InvokeModel'))) {
          bedrockResources.push(s.Resource);
        }
      }
    }
    const serialized = JSON.stringify(bedrockResources);
    expect(bedrockResources.length).toBeGreaterThan(0);
    // Overridden model is granted...
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-4-8');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-4-8');
    // ...defaults are NOT (override replaces, not appends)...
    expect(serialized).not.toContain('claude-sonnet-4-6');
    expect(serialized).not.toContain('claude-haiku-4-5');
    // ...and the grant is never a bare wildcard.
    expect(serialized).not.toContain('"*"');
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

  test('creates Cognito User Pool', () => {
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
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

  test('model invocation logging does NOT send an empty largeDataDeliveryS3Config', () => {
    // Regression guard (#215): sending largeDataDeliveryS3Config with an empty
    // bucketName fails client-side validation ("valid min length: 3"), and with
    // a catch-all ignoreErrorCodesMatching that failure silently leaves logging
    // DISABLED — so Bedrock records no requestMetadata. The field is optional;
    // omit it entirely. Assert it never reappears with an empty bucket.
    const customs = template.findResources('Custom::AWS');
    const logging = Object.values(customs).find(r =>
      JSON.stringify(r.Properties?.Create).includes('putModelInvocationLoggingConfiguration'),
    );
    expect(logging).toBeDefined();
    for (const phase of ['Create', 'Update'] as const) {
      const body = JSON.stringify(logging!.Properties?.[phase] ?? '');
      // Either absent, or — if ever re-added — must carry a real bucket name.
      expect(body).not.toContain('largeDataDeliveryS3Config');
    }
  });

  test('model invocation logging ignores only transient errors, not client-side validation', () => {
    // A catch-all '.*' would also swallow the empty-bucket ValidationException
    // above, hiding a deploy-time misconfiguration as silently-absent logging.
    const customs = template.findResources('Custom::AWS');
    const logging = Object.values(customs).find(r =>
      JSON.stringify(r.Properties?.Create).includes('putModelInvocationLoggingConfiguration'),
    );
    const create = JSON.stringify(logging!.Properties?.Create ?? '');
    expect(create).not.toContain('".*"');
    expect(create).toContain('ThrottlingException');
  });

  test('model invocation logging custom resource can iam:PassRole the logging role', () => {
    // PutModelInvocationLoggingConfiguration passes BedrockLoggingRole to the
    // Bedrock service, so the custom resource's role needs iam:PassRole on it.
    // Without this the API call fails at deploy (was previously masked by the
    // empty-bucket validation error). Assert the policy grants PassRole.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'iam:PassRole',
            Effect: 'Allow',
          }),
        ]),
      },
    });
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
      LogGroupName: '/aws/bedrock/model-invocation-logs/TestAgentStack',
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

describe('AgentStack with the ECS substrate gate (--context compute_type=ecs)', () => {
  let template: Template;

  beforeAll(() => {
    // Deploying with the gate on provisions the Fargate substrate alongside the
    // always-present AgentCore runtime; the ComputeSubstrate output flips to 'ecs'.
    const app = new App({ context: { compute_type: 'ecs' } });
    const stack = new AgentStack(app, 'TestAgentStackEcs', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('provisions an ECS cluster + Fargate task definition', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  });

  test('outputs ComputeSubstrate=ecs so the CLI allows compute_type=ecs onboarding', () => {
    template.hasOutput('ComputeSubstrate', { Value: 'ecs' });
  });
});

describe('AgentStack with the Lambda MicroVMs substrate gate (--context compute_type=lambda-microvm)', () => {
  const BASE_IMAGE_ARN = 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1';

  let template: Template;

  beforeAll(() => {
    // Gate ON *and* an image configured — the steady state. The intermediate
    // "gate on, no image yet" state is covered in the construct test; here the
    // point is the stack-level wiring (env vars + IAM + outputs) that only
    // exists once an image identifier is available.
    const app = new App({
      context: {
        compute_type: 'lambda-microvm',
        microvm_base_image_arn: BASE_IMAGE_ARN,
        microvm_base_image_version: '1',
      },
    });
    const stack = new AgentStack(app, 'TestAgentStackMicrovm', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('provisions the MicroVM image + egress network connector', () => {
    template.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 1);
  });

  test('does NOT provision the ECS substrate (the gates are mutually exclusive)', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 0);
    template.resourceCountIs('AWS::ECS::TaskDefinition', 0);
  });

  test('outputs ComputeSubstrate=lambda-microvm so the CLI allows that onboarding', () => {
    template.hasOutput('ComputeSubstrate', { Value: 'lambda-microvm' });
  });

  test('outputs everything the packaging script needs to find (no predictable physical names)', () => {
    for (const output of [
      'MicrovmArtifactBucketName',
      'MicrovmArtifactObjectKey',
      'MicrovmBuildRoleArn',
      'MicrovmExecutionRoleArn',
      'MicrovmEgressConnectorArns',
      'MicrovmLogGroupName',
    ]) {
      template.hasOutput(output, {});
    }
  });

  test('injects the four required MICROVM_* env vars the strategy reads', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const [, orchestrator] = Object.entries(fns)
      .find(([id]) => id.includes('TaskOrchestratorOrchestratorFn'))!;
    const env = orchestrator.Properties.Environment.Variables as Record<string, unknown>;

    expect(Object.keys(env).filter(k => k.startsWith('MICROVM_')).sort()).toEqual([
      'MICROVM_EGRESS_CONNECTOR_ARNS',
      'MICROVM_EXECUTION_ROLE_ARN',
      'MICROVM_IMAGE_IDENTIFIER',
      'MICROVM_PAYLOAD_BUCKET',
    ]);
    // Image version is deliberately unpinned, and no ingress connectors exist
    // in P1–P3 (nothing dials into the MicroVM, no JWE tokens are minted).
    expect(env.MICROVM_IMAGE_VERSION).toBeUndefined();
    expect(env.MICROVM_INGRESS_CONNECTOR_ARNS).toBeUndefined();
  });

  test('grants the orchestrator exactly the P1 lifecycle actions, image-scoped', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('TaskOrchestrator'));
    const statements = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Array<{
      Sid?: string;
      Action: string | string[];
      Resource: unknown;
    }>);

    const lifecycle = statements.find(s => s.Sid === 'MicrovmLifecycle')!;
    expect(lifecycle.Action).toEqual([
      'lambda:RunMicrovm',
      'lambda:GetMicrovm',
      'lambda:TerminateMicrovm',
    ]);
    // Every MicroVM lifecycle action authorizes against the *image* resource,
    // which is why "scoped to platform-created images" is achievable at all.
    expect(JSON.stringify(lifecycle.Resource)).toMatch(
      /"Fn::GetAtt":\["LambdaMicrovmComputeImage[^"]*","ImageArn"\]/,
    );

    // PassNetworkConnector supports no resource-level permissions.
    const pass = statements.find(s => s.Sid === 'MicrovmPassNetworkConnector')!;
    expect(pass.Action).toBe('lambda:PassNetworkConnector');
    expect(pass.Resource).toBe('*');

    // iam:PassRole for the execution role hand-off, service-conditioned.
    const passRole = statements.find(s => s.Sid === 'MicrovmPassExecutionRole')!;
    expect(passRole.Action).toBe('iam:PassRole');
  });

  test('does NOT grant suspend/resume (P3) or auth-token minting (never)', () => {
    const rendered = JSON.stringify(template.toJSON());
    expect(rendered).not.toContain('lambda:SuspendMicrovm');
    expect(rendered).not.toContain('lambda:ResumeMicrovm');
    expect(rendered).not.toContain('lambda:CreateMicrovmAuthToken');
    expect(rendered).not.toContain('lambda:CreateMicrovmShellAuthToken');
    expect(rendered).not.toContain('lambda:ConnectMicrovm');
  });

  test('orchestrator may WRITE the payload bucket; nothing grants it delete', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('TaskOrchestrator'));
    const statements = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Array<{
      Action: string | string[];
      Resource: unknown;
    }>);
    const payloadStatements = statements.filter(s =>
      JSON.stringify(s.Resource).includes('LambdaMicrovmComputePayloadBucket'));

    const actions = payloadStatements.flatMap(s => Array.isArray(s.Action) ? s.Action : [s.Action]);
    expect(actions).toContain('s3:PutObject');
    // The bucket's lifecycle rule is the reaper on this backend — unlike the ECS
    // path the orchestrator never deletes, so the grant must not exist.
    expect(actions).not.toContain('s3:DeleteObject');
  });

  test('cancel Lambda may terminate a MicroVM (and only terminate), image-scoped', () => {
    const policies = Object.entries(template.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('CancelTaskFn'));
    const statements = policies.flatMap(([, p]) => p.Properties.PolicyDocument.Statement as Array<{
      Action: string | string[];
      Resource: unknown;
    }>);
    const microvmStatements = statements.filter(s =>
      JSON.stringify(s.Action).includes('Microvm'));

    expect(microvmStatements).toHaveLength(1);
    expect(microvmStatements[0]!.Action).toBe('lambda:TerminateMicrovm');
    // Resolved through the stack's Lazy.string to the actual image resource
    // (TaskApi is built before the MicroVM construct), so the grant names ONE
    // image instead of an account/Region-wide `microvm-image:*`.
    const rendered = JSON.stringify(microvmStatements[0]!.Resource);
    expect(rendered).toMatch(/LambdaMicrovmComputeImage[^"]*","ImageArn"/);
    expect(rendered).not.toContain('microvm-image:*');
  });

  test('MicroVM resources carry the backend cost-allocation tag', () => {
    template.hasResourceProperties('AWS::Lambda::MicrovmImage', {
      Tags: Match.arrayWith([{ Key: 'abca:compute-backend', Value: 'lambda-microvm' }]),
    });
    template.hasResourceProperties('AWS::Lambda::NetworkConnector', {
      Tags: Match.arrayWith([{ Key: 'abca:compute-backend', Value: 'lambda-microvm' }]),
    });
  });

  describe('Region gate', () => {
    // TEST-CONVENTION EXEMPTION (cdk/AGENTS.md "synth once in beforeAll"): the
    // failure case asserts the STACK CONSTRUCTOR throws, so there is no template
    // to cache. It is also cheap — the gate runs inside the MicroVM construct
    // before any resource is created, and no `Template.fromStack()` is called.
    // The success case (escape hatch) does need a template, so it is cached here.
    let overriddenTemplate: Template;

    beforeAll(() => {
      const app = new App({
        context: {
          compute_type: 'lambda-microvm',
          microvm_region_override: true,
          microvm_base_image_arn: BASE_IMAGE_ARN,
          microvm_base_image_version: '1',
        },
      });
      overriddenTemplate = Template.fromStack(new AgentStack(app, 'TestAgentStackMicrovmOverride', {
        env: { account: '123456789012', region: 'eu-central-1' },
      }));
    });

    test('fails synth when the stack Region has no Lambda MicroVMs', () => {
      const app = new App({ context: { compute_type: 'lambda-microvm' } });
      expect(() => new AgentStack(app, 'TestAgentStackMicrovmBadRegion', {
        env: { account: '123456789012', region: 'eu-central-1' },
      })).toThrow(/AWS Lambda MicroVMs are not available in eu-central-1/);
    });

    test('the microvm_region_override context flag unblocks an unsupported Region', () => {
      overriddenTemplate.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
    });
  });
});

describe('AgentStack default (agentcore) deploy — MicroVM substrate absent', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new AgentStack(app, 'TestAgentStackNoMicrovm', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('synthesizes no MicroVM resources', () => {
    template.resourceCountIs('AWS::Lambda::MicrovmImage', 0);
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 0);
  });

  test('injects no MICROVM_* env vars', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function'));
    for (const fn of fns) {
      const env = (fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>;
      expect(Object.keys(env).filter(k => k.startsWith('MICROVM_'))).toEqual([]);
    }
  });

  test('grants no MicroVM IAM actions anywhere', () => {
    // Scoped to policy documents rather than the whole template: cdk-nag
    // suppression *reasons* legitimately mention the actions in prose.
    const statements = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(p => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>);
    const actions = statements.flatMap(s => Array.isArray(s.Action) ? s.Action : [s.Action]);
    expect(actions.filter(a => a.includes('Microvm'))).toEqual([]);
  });
});

describe('AgentStack with the MicroVM gate on but no image configured (first deploy)', () => {
  let template: Template;

  beforeAll(() => {
    // The bootstrap state: substrate provisioned so the artifact bucket exists,
    // but no image yet. Exercises the false branch of the shared
    // `isLambdaMicrovmImageConfigured` predicate that gates BOTH the
    // orchestrator's MICROVM_* wiring and the cancel Lambda's grant.
    const app = new App({ context: { compute_type: 'lambda-microvm' } });
    const stack = new AgentStack(app, 'TestAgentStackMicrovmNoImage', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('provisions the substrate (buckets, roles, connector) but no image', () => {
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 1);
    template.resourceCountIs('AWS::Lambda::MicrovmImage', 0);
    template.hasOutput('MicrovmArtifactBucketName', {});
  });

  test('grants no MicroVM IAM actions at all — nothing to run or cancel yet', () => {
    // Notably this also proves the stack never resolves the image-ARN Lazy in
    // this state: doing so would throw "accessed before LambdaMicrovmCompute was
    // created"-class errors rather than synthesize.
    const actions = Object.values(template.findResources('AWS::IAM::Policy'))
      .flatMap(p => p.Properties.PolicyDocument.Statement as Array<{ Action: string | string[] }>)
      .flatMap(s => Array.isArray(s.Action) ? s.Action : [s.Action]);
    expect(actions.filter(a => a.includes('Microvm'))).toEqual([]);
  });

  test('injects no MICROVM_* env vars (the strategy fails fast with its own remedy)', () => {
    const fns = Object.values(template.findResources('AWS::Lambda::Function'));
    const keys = fns.flatMap(fn =>
      Object.keys((fn.Properties.Environment?.Variables ?? {}) as Record<string, unknown>));
    expect(keys.filter(k => k.startsWith('MICROVM_'))).toEqual([]);
  });
});

describe('AgentStack MicroVM image ARN invariant', () => {
  let synthError: unknown;

  beforeAll(() => {
    // Force the stack-side gate true while the real construct remains in its
    // no-image bootstrap state. This is the only way to exercise the Lazy's
    // defensive invariant without changing production behavior.
    const configuredSpy = jest.spyOn(lambdaMicrovmCompute, 'isLambdaMicrovmImageConfigured')
      .mockReturnValue(true);
    try {
      const app = new App({ context: { compute_type: 'lambda-microvm' } });
      const stack = new AgentStack(app, 'TestAgentStackMicrovmInvariant', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      Template.fromStack(stack);
    } catch (err) {
      synthError = err;
    } finally {
      configuredSpy.mockRestore();
    }
  });

  test('fails synth if a configured deployment has no image ARN', () => {
    expect(synthError).toEqual(expect.objectContaining({
      message: expect.stringContaining(
        'MicroVM image ARN was accessed before LambdaMicrovmCompute was created',
      ),
    }));
  });
});
