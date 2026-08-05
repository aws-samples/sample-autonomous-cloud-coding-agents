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

  test('creates exactly 21 DynamoDB tables', () => {
    // task, task-events, repo, user-concurrency, webhook, task-nudges,
    // task-approvals (Cedar HITL V2),
    // api-key (platform API keys for headless webhook management, #376/#579),
    // slack-installation, slack-user-mapping,
    // slack-channel-mapping (channel → default-repo onboarding),
    // linear-project-mapping, linear-user-mapping, linear-webhook-dedup,
    // linear-workspace-registry (added in Phase 2.0b for OAuth bookkeeping),
    // github-webhook-dedup (added by GitHubScreenshotIntegration),
    // jira-project-mapping, jira-user-mapping, jira-workspace-registry,
    // jira-webhook-dedup (added for the Jira Cloud integration on main),
    // orchestration (added by #247 — parent/sub-issue DAG state).
    // = 16 shared/base + 4 Jira + 1 orchestration = 21.
    template.resourceCountIs('AWS::DynamoDB::Table', 21);
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

    // Collect every bedrock:InvokeModel statement's Resource across the IAM
    // policies the ``bedrockModels`` override GOVERNS: the runtime execution role
    // and the per-task session role (the coding agent's task-model grants). The
    // override replaces the model set for the WORKLOAD; these are its surfaces.
    //
    // Deliberately EXCLUDES the Linear webhook processor's policy: the #299
    // deterministic-revise interpreter (linear-integration.ts) makes one tiny
    // "which plan-edit did they mean?" classification call pinned to a FIXED
    // model (DEFAULT_REVISE_MODEL_ID = sonnet), by design independent of the
    // per-task ``bedrockModels`` override — you don't want a cheap classification
    // running on whatever heavyweight coding model an operator selected. That
    // grant is scoped to its single fixed model (asserted in the linear
    // integration tests), so it's not a wildcard/drift risk; it just isn't part
    // of the override contract this test checks.
    const OVERRIDE_GOVERNED_POLICY_PREFIXES = ['RuntimeExecutionRole', 'AgentSessionRole'];
    const policies = overridden.findResources('AWS::IAM::Policy');
    const bedrockResources: unknown[] = [];
    for (const [logicalId, p] of Object.entries(policies)) {
      if (!OVERRIDE_GOVERNED_POLICY_PREFIXES.some((prefix) => logicalId.startsWith(prefix))) continue;
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

  test('the orchestration reconciler can reach BOTH surfaces\' credentials registries', () => {
    // It picks the feedback surface from each orchestration's own recorded
    // channel, so a registry it can't read means that surface's orchestrations
    // silently lose their panel + reactions.
    const fns = template.findResources('AWS::Lambda::Function');
    const reconciler = Object.entries(fns).find(([id]) => id.startsWith('OrchestrationReconciler'));
    expect(reconciler).toBeDefined();
    const vars = (reconciler![1] as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
      .Properties?.Environment?.Variables ?? {};
    expect(vars.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();
    expect(vars.JIRA_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();
  });

  test('the iteration heartbeat can reach BOTH surfaces and refresh Jira OAuth', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const heartbeat = Object.entries(fns).find(([id]) => id.startsWith('IterationHeartbeat'));
    expect(heartbeat).toBeDefined();
    const vars = (heartbeat![1] as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
      .Properties?.Environment?.Variables ?? {};
    expect(vars.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();
    expect(vars.JIRA_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();

    const policies = template.findResources('AWS::IAM::Policy');
    const heartbeatPolicies = Object.entries(policies)
      .filter(([logicalId]) => logicalId.startsWith('IterationHeartbeat'));
    const asJson = JSON.stringify(heartbeatPolicies.map(([, policy]) => policy));
    expect(asJson).toContain('bgagent-jira-oauth-*');
    expect(asJson).toContain('secretsmanager:GetSecretValue');
    expect(asJson).toContain('secretsmanager:PutSecretValue');
  });

  test('the orchestration reconciler cannot read S3 objects at all', () => {
    // The trace/artifacts bucket holds full agent trajectories under
    // traces/<user_id>/ — tool input and output, authorized per-user by the presign
    // handler. The reconciler works entirely from task records and the orchestration
    // table, so it needs no object read anywhere; asserting the absence keeps a
    // component that handles no user identity out of that blast radius, and makes a
    // future grant a deliberate, visible choice.
    //
    // Absence rather than a scoped grant is the stronger claim, and the safer one:
    // S3 does not normalize keys, so `artifacts/../traces/u/x` is a literal key that
    // an `artifacts/*` resource matches by string prefix.
    const policies = template.findResources('AWS::IAM::Policy');
    const reconciler = Object.entries(policies).filter(([id]) => id.startsWith('OrchestrationReconciler'));
    // The reconciler DOES have policies (table + invoke + guardrail grants), so an
    // empty set here would mean the id filter broke, not that the grant is gone.
    expect(reconciler.length).toBeGreaterThan(0);

    const objectStatements: string[] = [];
    for (const [, policy] of reconciler) {
      const doc = (policy as { Properties: { PolicyDocument: { Statement: Array<Record<string, unknown>> } } })
        .Properties.PolicyDocument.Statement;
      for (const stmt of doc) {
        const actions = JSON.stringify(stmt.Action ?? '');
        if (!/s3:(Get|Put|Delete)Object/.test(actions)) continue;
        objectStatements.push(JSON.stringify(stmt));
      }
    }
    expect(objectStatements).toEqual([]);
  });

  test('log-delivery logical ids are pinned with NO opt-in, so an existing stack updates in place', () => {
    // A DeliverySource is unique per (resource ARN, log type) for the whole
    // account, and the runtime ARN survives a library-side rename of these
    // auto-created resources. So a renamed source is a SECOND source for the same
    // runtime: CloudFormation creates before deleting, CloudWatch Logs rejects it
    // as already existing, and the update rolls the whole stack back.
    //
    // The ids must therefore be pinned unconditionally. Behind a flag, the safe
    // path is the one an operator has to already know about, and the failure that
    // teaches them is a mid-update rollback whose message never mentions it.
    //
    // Asserted on the source, not by synthesizing a second stack: constructing
    // one under a different construct id trips an unrelated cdk-nag
    // suppression-path check first, which masks whatever this is checking.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/stacks/agent.ts'), 'utf8',
    );
    const fn = src.slice(src.indexOf('function pinLogDeliveryLogicalIds'));
    const body = fn.slice(0, fn.indexOf('\n}'));

    // Keyed off the stack's OWN name — no context, no opt-in.
    expect(body).toContain('PINNED_LOG_DELIVERY_BY_STACK[stack.stackName]');
    expect(body).not.toContain('tryGetContext');
    // Nothing anywhere may reintroduce a gate.
    expect(src).not.toContain('pinnedLogDeliveryStack');

    // The ids it pins are the ones CloudFormation already holds for that stack.
    // Hard-coded here on purpose: if someone "tidies" a value in the table, this
    // fails instead of the next production update rolling back.
    expect(src).toContain('RuntimeCDKSourceAPPLICATIONLOGSbackgroundagentdevRuntimeBC0AE9ED96A02E02');
    expect(src).toContain('RuntimeCDKSourceUSAGELOGSbackgroundagentdevRuntimeBC0AE9ED544FBB22');
  });

  test('a stack with no recorded ids keeps the library\'s own log-delivery naming', () => {
    // The pinned ids embed a stack name, so they are only correct for that stack.
    // Another stack has no pre-rename resources to line up with and must not
    // inherit them — otherwise two stacks in one account would claim the same
    // account-unique DeliverySource Name. The table lookup is what enforces this,
    // so assert it returns nothing for an unknown name rather than falling back.
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/stacks/agent.ts'), 'utf8',
    );
    const fn = src.slice(src.indexOf('function pinLogDeliveryLogicalIds'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/if \(!pins\) return;/);

    // And this stack — named TestAgentStack, absent from the table — got the
    // library's naming, with none of backgroundagent-dev's ids leaking in.
    const ids = Object.keys(template.findResources('AWS::Logs::DeliverySource'));
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).not.toContain('backgroundagentdev');
    }
  });

  test('the fan-out consumer can reach BOTH surfaces\' credentials registries', () => {
    // These props are optional on FanOutConsumer, so dropping either one from
    // the stack silently disables that surface's terminal-status comments.
    const fns = template.findResources('AWS::Lambda::Function');
    const fanout = Object.entries(fns).find(([id]) => id.startsWith('FanOutConsumer'));
    expect(fanout).toBeDefined();
    const vars = (fanout![1] as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
      .Properties?.Environment?.Variables ?? {};
    expect(vars.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();
    expect(vars.JIRA_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();
  });

  test('the fan-out consumer is granted read on BOTH surfaces\' OAuth secret prefixes', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const fanoutPolicies = Object.entries(policies)
      .filter(([id]) => id.startsWith('FanOutConsumer'))
      .map(([, policy]) => policy);
    const asJson = JSON.stringify(fanoutPolicies);
    expect(asJson).toContain('bgagent-linear-oauth-*');
    expect(asJson).toContain('bgagent-jira-oauth-*');
  });

  test('the stranded-orchestration sweep gets the registry its panel refresh needs', () => {
    // It shares refreshPanelAndSettle with the live reconciler; without a
    // registry that feedback no-ops and a recovered epic's panel stays stale.
    const fns = template.findResources('AWS::Lambda::Function');
    const sweep = Object.entries(fns).find(([id]) => id.startsWith('StrandedOrchestrationReconciler'));
    expect(sweep).toBeDefined();
    const vars = (sweep![1] as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
      .Properties?.Environment?.Variables ?? {};
    expect(vars.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();
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

  test('provisions an ECS cluster + both Fargate task definitions (build + planning)', () => {
    template.resourceCountIs('AWS::ECS::Cluster', 1);
    // #299 ECS_RIGHTSIZED_PLANNING: two task defs now — the 64 GB build def and
    // the 8 GB read-only planning def (decompose-v1 runs on the smaller one).
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
  });

  test('outputs ComputeSubstrate=ecs so the CLI allows compute_type=ecs onboarding', () => {
    template.hasOutput('ComputeSubstrate', { Value: 'ecs' });
  });
});
