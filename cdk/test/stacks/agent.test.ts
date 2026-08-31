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
import { App, AspectPriority, Aspects } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  BEDROCK_GEO_REGION_CONTEXT_KEY,
  DEFAULT_BEDROCK_GEO_REGION,
  DEFAULT_BEDROCK_MODEL_IDS,
} from '../../src/constructs/bedrock-models';
import * as lambdaMicrovmCompute from '../../src/constructs/lambda-microvm-compute';
import { buildAppId, SolutionUaAspect } from '../../src/constructs/solution-ua-aspect';
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

  /**
   * CloudFormation refuses a template over 1 MB, and it refuses it at CHANGESET
   * CREATION — after synth succeeds, after every asset is built and pushed. The
   * message is `Template may not exceed 1000000 bytes in size.` and it names no
   * resource, so it reads as an infrastructure fault rather than "this template
   * grew". Worse, the stack's own status stays at whatever the previous deploy left,
   * so a status check reports success while nothing shipped.
   *
   * This is not hypothetical headroom. `compute_type=ecs` — the substrate deployments
   * actually use — synthesizes at 992,111 bytes against the 1,000,000 ceiling. That
   * is 7,889 bytes, roughly one medium construct.
   *
   * (`compute_type=lambda-microvm` is already past the ceiling, which is how this was
   * noticed. That substrate is still in development, so its template not fitting yet
   * is expected rather than a defect — it is not the reason this guard exists.)
   *
   * Asserted as a BUDGET below the real ceiling so the failure lands here — in a
   * test that says what the limit is and what to do — rather than at the end of a
   * deploy. Raising this number is not the fix; moving resources under a nested
   * stack (the stack already has two) is.
   */
  test('stays inside a deployable template budget (CloudFormation hard-fails at 1 MB)', () => {
    // Measured the way the CDK CLI WRITES the template, which is how CloudFormation
    // counts it: `JSON.stringify(t, null, 2)`. This matters more than it looks —
    // compact serialization of the same template is ~700 KB while the file the CLI
    // uploads is ~1,010 KB. About 310 KB is indentation. A budget asserted against
    // compact bytes passes comfortably while the real deploy fails, which is exactly
    // the trap the first version of this test fell into.
    const bytes = Buffer.byteLength(JSON.stringify(template.toJSON(), null, 2), 'utf8');
    const CFN_TEMPLATE_LIMIT_BYTES = 1_000_000;
    // 5% below the ceiling, so this fires while there is still room to land the
    // change that trips it rather than at the end of a deploy that has already
    // pushed its assets.
    const BUDGET_BYTES = 950_000;
    expect(bytes).toBeLessThan(CFN_TEMPLATE_LIMIT_BYTES);
    expect(bytes).toBeLessThan(BUDGET_BYTES);
  });

  test('creates exactly 21 DynamoDB tables', () => {
    // task, task-events, repo, user-concurrency, webhook, task-nudges,
    // task-approvals (Cedar HITL V2),
    // api-key (platform API keys for headless webhook management),
    // slack-installation, slack-user-mapping,
    // slack-channel-mapping (channel → default-repo onboarding),
    // linear-project-mapping, linear-user-mapping, linear-webhook-dedup,
    // linear-workspace-registry (added in Phase 2.0b for OAuth bookkeeping),
    // github-webhook-dedup (added by GitHubScreenshotIntegration),
    // jira-project-mapping, jira-user-mapping, jira-workspace-registry,
    // jira-webhook-dedup (added for the Jira Cloud integration on main),
    // orchestration (parent/sub-issue DAG state).
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

  test('the orchestrator carries the platform_config transport env on EVERY compute type', () => {
    // Wired unconditionally rather than under the lambda-microvm gate: the strategy
    // fails a session start when a required identifier is missing, and that guard
    // must only ever fire for a hand-edited Lambda environment — never because a
    // deploy-time gate and a per-repo `compute_type` disagreed. These are the
    // MicroVM's substitute for the AgentCore runtime env block / ECS container env,
    // since a snapshot must not bake configuration in (ADR-021 sub-decision 3).
    const [, orchestrator] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .find(([id]) => id.includes('TaskOrchestratorOrchestratorFn'))!;
    const env = orchestrator.Properties.Environment.Variables as Record<string, unknown>;

    for (const key of [
      'TASK_APPROVALS_TABLE_NAME',
      'NUDGES_TABLE_NAME',
      'LOG_GROUP_NAME',
      'ARTIFACTS_BUCKET_NAME',
      'TRACE_ARTIFACTS_BUCKET_NAME',
      'AGENT_SESSION_ROLE_ARN',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    ]) {
      expect(env[key]).toBeDefined();
    }
    // Plus the three the orchestrator already carried for its own work — together
    // these cover all four identifiers the MicroVM strategy treats as required.
    expect(env.TASK_TABLE_NAME).toBeDefined();
    expect(env.TASK_EVENTS_TABLE_NAME).toBeDefined();
    expect(env.GITHUB_TOKEN_SECRET_ARN).toBeDefined();
  });

  test('the forwarded identifiers are the SAME stack values the AgentCore runtime gets', () => {
    // One stack value, one env-var name, three backends — so an agent behaves
    // identically on every substrate and a value can only be changed in one place.
    // A drift here would mean a MicroVM agent writing approvals to a different
    // table than an AgentCore agent on the same deployment.
    const [, orchestrator] = Object.entries(template.findResources('AWS::Lambda::Function'))
      .find(([id]) => id.includes('TaskOrchestratorOrchestratorFn'))!;
    const orchestratorEnv = orchestrator.Properties.Environment.Variables as Record<string, unknown>;

    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const runtimeEnv = Object.values(runtimes)[0]!.Properties.EnvironmentVariables as Record<string, unknown>;

    for (const key of [
      'TASK_APPROVALS_TABLE_NAME',
      'NUDGES_TABLE_NAME',
      'LOG_GROUP_NAME',
      'ARTIFACTS_BUCKET_NAME',
      'TRACE_ARTIFACTS_BUCKET_NAME',
      'AGENT_SESSION_ROLE_ARN',
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'TASK_TABLE_NAME',
      'TASK_EVENTS_TABLE_NAME',
      'GITHUB_TOKEN_SECRET_ARN',
    ]) {
      expect(JSON.stringify(orchestratorEnv[key])).toEqual(JSON.stringify(runtimeEnv[key]));
    }
  });

  test('outputs ComputeSubstrate=agentcore on the default (no-gate) deploy', () => {
    // The CLI reads this to refuse onboarding a repo as compute_type=ecs on a
    // stack that never provisioned the ECS substrate.
    template.hasOutput('ComputeSubstrate', { Value: 'agentcore' });
  });

  test('outputs BedrockGeoRegion so a client can check the profile it will invoke', () => {
    // `platform doctor` reads this. Without it, its Bedrock check can only ask "is
    // this model published in this Region", which passes on a stack granted
    // profiles the account cannot invoke — the failure then lands at turn 0 as
    // AccessDenied. Defaults to `us`; the test app passes no context.
    template.hasOutput('BedrockGeoRegion', { Value: 'us' });
  });

  test('outputs CedarWasmLayerArn', () => {
    template.hasOutput('CedarWasmLayerArn', {});
  });

  test('enables Agent Registry by default', () => {
    template.hasOutput('AgentRegistryId', {});
    template.hasOutput('AgentRegistryArn', {});
    template.hasOutput('RegistryApiUrl', {});
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

  test('default Haiku model env var is the cross-region inference profile, not the bare model id', () => {
    // Claude 4.x on Bedrock cannot be invoked on-demand by bare foundation-model
    // id (400 "on-demand throughput isn't supported"); WebFetch's Haiku sub-calls
    // hit this. The env var must be the granted inference profile.
    //
    // The expectation is DERIVED from the default geography rather than hardcoded
    // `us.` (#746): the prefix is now a function of `bedrockGeoRegion`, so a
    // hardcoded literal here would assert the default's value twice and go stale
    // the moment the default moves — while the thing worth guarding (main and
    // auxiliary models routing through the SAME geography) went unchecked.
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    for (const rt of Object.values(runtimes)) {
      const envVars = (rt as { Properties?: { EnvironmentVariables?: Record<string, unknown> } })
        .Properties?.EnvironmentVariables ?? {};
      expect(envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL)
        .toBe(`${DEFAULT_BEDROCK_GEO_REGION}.anthropic.claude-haiku-4-5-20251001-v1:0`);
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

  test('runtime is granted the default Bedrock model set', () => {
    // Default (no bedrockModels context): the runtime execution role must hold
    // bedrock:InvokeModel on every default foundation model + its US
    // inference profile, scoped (never Resource: '*').
    //
    // The `us.` literals below are deliberate, not stale (#746): this test pins
    // the DEFAULT deploy, and the default geography is still `us`. The
    // geo-parameterized behaviour is covered separately; template identity under
    // default context is covered by the exact-set test further down.
    const serialized = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(serialized).toContain('foundation-model/anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-sonnet-4-6');
    expect(serialized).toContain('anthropic.claude-opus-4-8');
    expect(serialized).toContain('anthropic.claude-haiku-4-5-20251001-v1:0');
    // Claude Opus 5 (#744). Granted ahead of any default flip: the bare id is
    // not on-demand invocable (Bedrock returns ValidationException), so the
    // `us.`-prefixed inference profile is the one actually called — both ARNs
    // must be present or the agent gets AccessDenied at turn 0.
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-5');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-5');
    // REGRESSION (#744): Opus 4.8 stays granted alongside Opus 5. Blueprints may
    // pin 4.8 per-repo; dropping it would fail those repos at turn 0. Retiring
    // 4.8 is a separate, announced change — not a side effect of adding 5.
    expect(serialized).toContain('foundation-model/anthropic.claude-opus-4-8');
    expect(serialized).toContain('inference-profile/us.anthropic.claude-opus-4-8');
  });

  test('bedrockModels context override propagates to the runtime execution role', () => {
    // The runtime-role half of the override contract (the ECS side is covered in
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
    // The prefix filter, not a blanket scan, is what this test asserts against.
    // On main those two roles are in fact the ONLY policies in the stack holding
    // a bedrock:InvokeModel statement — the Linear webhook processor deliberately
    // has none (`linear-integration.ts`: "No bedrock:InvokeModel grant: this
    // processor never calls a model directly"; its only Bedrock action is
    // ApplyGuardrail). So the filter is currently a no-op belt-and-braces guard
    // that keeps this assertion honest if a future construct adds an
    // InvokeModel grant that the ``bedrockModels`` override is not meant to
    // govern — e.g. a cheap fixed-model classification call, which you would not
    // want running on whatever heavyweight coding model an operator selected.
    //
    // (An earlier revision of this comment cited a fixed-model revise grant via a
    // `DEFAULT_REVISE_MODEL_ID` constant. That constant and its
    // orchestration-plan-revise-interpret module exist only on the unmerged
    // #299 branch and never landed on main, so the reference was dangling — see
    // #742. Corrected rather than deleted to record that the exclusion describes
    // a hypothetical, not a live grant.)
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

  /**
   * TEMPLATE IDENTITY (#746). Making the inference-profile geography
   * configurable must not MOVE it: the default is still `us`, so a stack
   * deployed before this change and re-synthesized after it must produce the
   * same Bedrock IAM resources. That is the whole safety argument for shipping
   * the refactor on its own, ahead of the geo flip (#747) — so it is asserted,
   * not asserted-in-a-PR-description.
   *
   * The expected set below is the literal, exhaustive list captured from a
   * pre-change `origin/main` synth of this same stack (`fb1e007b`, before the
   * `bedrockGeoRegion` key existed) — every `foundation-model/…` and
   * `inference-profile/…` resource name appearing in any `bedrock:` IAM
   * statement of the default-context template. Asserted as EXACT set equality,
   * so the refactor can neither add, drop, nor re-prefix a grant unnoticed. A
   * `toContain`-style check would pass on a template that also granted
   * something new.
   *
   * (The full 25k-line template was also diffed pre/post out-of-band and is
   * identical modulo CDK's own local synth non-determinism — asset hashes,
   * custom-resource timestamps, the InputGuardrail version logical id — which
   * differ between two synths of the SAME tree and so cannot be asserted here.
   * The Bedrock resources are the change's entire blast radius.)
   */
  test('default-context Bedrock grants are the exact expected set, nothing wider', () => {
    // `anthropic.claude-opus-4-20250514-v1:0` was REMOVED from this baseline
    // deliberately: it has no cross-Region inference profile in any geography, so
    // the pair of ARNs it contributed granted a profile that cannot exist while
    // making the model pass every admission check that reads the grant list. This
    // exact-set assertion is what makes that removal reviewable — a grant cannot be
    // added, dropped, or re-prefixed without failing here.
    const EXPECTED_BEDROCK_RESOURCE_NAMES = [
      'foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
      'foundation-model/anthropic.claude-opus-4-8',
      'foundation-model/anthropic.claude-opus-5',
      'foundation-model/anthropic.claude-sonnet-4-6',
      'inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'inference-profile/us.anthropic.claude-opus-4-8',
      'inference-profile/us.anthropic.claude-opus-5',
      'inference-profile/us.anthropic.claude-sonnet-4-6',
    ];

    const serialized = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    const found = [...new Set(
      serialized.match(/(?:foundation-model|inference-profile)\/[^"]+/g) ?? [],
    )].sort();
    expect(found).toEqual(EXPECTED_BEDROCK_RESOURCE_NAMES);

    // Sanity: the set is derived from the shared model list, so a model added to
    // DEFAULT_BEDROCK_MODEL_IDS without updating this baseline fails loudly here
    // rather than silently widening the "identical" claim.
    expect(found).toHaveLength(DEFAULT_BEDROCK_MODEL_IDS.length * 2);

    // And the auxiliary-model env var is still the `us.` profile it always was.
    const runtimes = template.findResources('AWS::BedrockAgentCore::Runtime');
    const envVars = (Object.values(runtimes)[0] as {
      Properties?: { EnvironmentVariables?: Record<string, unknown> };
    }).Properties?.EnvironmentVariables ?? {};
    expect(envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL)
      .toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    expect(DEFAULT_BEDROCK_GEO_REGION).toBe('us');
  });

  /**
   * The point of the key: a non-`us` deploy must be reachable from context
   * alone, with no construct edit. Parameterized over the geographies with a
   * distinct ARN shape from the default, `global` included — `global.` was the
   * specific case verified live (its profile ARN is regional + account-qualified,
   * identical in shape to `us.`), and is what #747 will flip the default to.
   */
  describe.each(['global', 'eu', 'apac'])('bedrockGeoRegion=%s', (geo) => {
    let geoTemplate: Template;

    beforeAll(() => {
      const app = new App({ context: { [BEDROCK_GEO_REGION_CONTEXT_KEY]: geo } });
      const stack = new AgentStack(app, `GeoAgentStack${geo.replace('-', '')}`, {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      geoTemplate = Template.fromStack(stack);
    });

    test('injects BOTH models into the runtime env at this geography', () => {
      // The headline fix, and it had no guard: deleting the ANTHROPIC_MODEL line from
      // the runtime env survived the whole suite. The stack previously injected only
      // the auxiliary model, so the main one fell through to a Python literal a
      // geography change does not touch — grants moved, the agent did not, and every
      // task with no per-repo override failed at turn 0 with AccessDenied.
      //
      // Asserted per geography rather than once, because the failure only appears
      // when the two disagree.
      const runtimes = geoTemplate.findResources('AWS::BedrockAgentCore::Runtime');
      const envs = Object.values(runtimes).map(
        (r) => (r as { Properties?: { EnvironmentVariables?: Record<string, string> } })
          .Properties?.EnvironmentVariables ?? {},
      );
      expect(envs.length).toBeGreaterThan(0);
      for (const env of envs) {
        expect(env.ANTHROPIC_MODEL).toBe(`${geo}.anthropic.claude-opus-5`);
        expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL)
          .toBe(`${geo}.anthropic.claude-haiku-4-5-20251001-v1:0`);
      }
    });

    test('re-prefixes every inference-profile ARN and drops the us. ones', () => {
      const serialized = JSON.stringify(geoTemplate.findResources('AWS::IAM::Policy'));
      for (const modelId of DEFAULT_BEDROCK_MODEL_IDS) {
        expect(serialized).toContain(`inference-profile/${geo}.${modelId}`);
        // The default geography must be GONE, not merely joined — a grant left
        // on `us.` while the agent calls `global.` is an AccessDenied at turn 0.
        expect(serialized).not.toContain(`inference-profile/us.${modelId}`);
        // The foundation-model half is already geo-agnostic (region: '*'), so it
        // is unchanged — and must NOT pick up a geo prefix.
        expect(serialized).toContain(`foundation-model/${modelId}`);
        expect(serialized).not.toContain(`foundation-model/${geo}.${modelId}`);
      }
      // Still per-model scoped; the geo knob must never become a wildcard.
      // Scoped to the bedrock:InvokeModel* statements — the stack legitimately
      // holds Resource:'*' elsewhere (ec2/route53resolver describes have no
      // resource-level scoping), so a blanket scan would assert nothing here.
      const bedrockStatements: unknown[] = [];
      for (const p of Object.values(geoTemplate.findResources('AWS::IAM::Policy'))) {
        for (const s of (p.Properties?.PolicyDocument?.Statement ?? []) as Array<{ Action?: unknown; Resource?: unknown }>) {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          if (actions.some((a) => typeof a === 'string' && a.startsWith('bedrock:InvokeModel'))) {
            bedrockStatements.push(s.Resource);
          }
        }
      }
      expect(bedrockStatements.length).toBeGreaterThan(0);
      expect(bedrockStatements).not.toContain('*');
      expect(JSON.stringify(bedrockStatements)).not.toContain('"*"');
    });

    test('derives the auxiliary Haiku model prefix from the same key', () => {
      // Without this the main model routes through `geo` while WebFetch's Haiku
      // sub-calls still ask for `us.` — a grant/env split that only shows up as a
      // mid-task failure on the auxiliary path.
      const runtimes = geoTemplate.findResources('AWS::BedrockAgentCore::Runtime');
      for (const rt of Object.values(runtimes)) {
        const envVars = (rt as { Properties?: { EnvironmentVariables?: Record<string, unknown> } })
          .Properties?.EnvironmentVariables ?? {};
        expect(envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL)
          .toBe(`${geo}.anthropic.claude-haiku-4-5-20251001-v1:0`);
      }
    });
  });

  test('an unknown bedrockGeoRegion fails at synth, not at turn 0', () => {
    // Synth-time because the value feeds grantInvoke's ARN construction: a
    // CloudFormation parameter would resolve after synth and force the grant back
    // to Resource: '*'. A typo must therefore fail here, loudly.
    const app = new App({ context: { [BEDROCK_GEO_REGION_CONTEXT_KEY]: 'usa' } });
    expect(() => new AgentStack(app, 'BadGeoAgentStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })).toThrow(/must be one of/);
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
    // Regression guard: sending largeDataDeliveryS3Config with an empty
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
    // Its Jira and Linear props are OPTIONAL on the construct, so dropping one
    // from the stack wiring disables that surface's final-status comment with no
    // synth error and no test failure elsewhere — a silent capability loss. Pin
    // both env vars so the omission fails here instead.
    const fns = template.findResources('AWS::Lambda::Function');
    const fanout = Object.entries(fns).find(([id]) => id.startsWith('FanOutConsumer'));
    expect(fanout).toBeDefined();
    const vars = (fanout![1] as { Properties?: { Environment?: { Variables?: Record<string, unknown> } } })
      .Properties?.Environment?.Variables ?? {};
    expect(vars.LINEAR_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();
    expect(vars.JIRA_WORKSPACE_REGISTRY_TABLE_NAME).toBeDefined();
  });

  test('the fan-out consumer is granted read on BOTH surfaces\' OAuth secret prefixes', () => {
    // The registry table alone is not enough to post a comment — the dispatcher
    // also needs the per-workspace OAuth secret.
    //
    // Scoped to the FanOutConsumer's OWN policy, deliberately. Grepping every
    // synthesized policy for these ARN patterns passes even when the fan-out's
    // grant is dropped, because the orchestrator and the webhook processors hold
    // the same prefixes — the assertion then proves nothing about this consumer.
    const policies = template.findResources('AWS::IAM::Policy');
    const fanoutPolicies = Object.entries(policies)
      .filter(([logicalId]) => logicalId.startsWith('FanOutConsumer'));
    expect(fanoutPolicies.length).toBeGreaterThan(0);
    const asJson = JSON.stringify(fanoutPolicies.map(([, p]) => p));
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

  test('provisions a single OperationalAlerts SNS topic + CMK and exports its ARN (#629)', () => {
    // One stack-wide topic, not per-consumer — every DLQ-depth alarm
    // shares one subscription surface.
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.hasResourceProperties('AWS::SNS::Topic', {
      KmsMasterKeyId: Match.anyValue(),
    });
    template.hasOutput('OperationalAlertsTopicArn', {
      Description: Match.stringLikeRegexp('#629'),
    });
  });

  test('wires all three DLQ-depth alarms to the alerts topic (#629)', () => {
    // FanOut, ApprovalMetricsPublisher, and the screenshot processor
    // DLQ alarms must each carry an AlarmActions entry — otherwise a
    // poison-pill pile-up stays silent (the whole point of #629).
    const alarms = template.findResources('AWS::CloudWatch::Alarm');
    const dlqAlarmsWithActions = Object.values(alarms).filter((r: any) => {
      const dims: Array<{ Name: string }> = r.Properties?.Dimensions ?? [];
      const isSqsDepth =
        r.Properties?.Namespace === 'AWS/SQS' &&
        r.Properties?.MetricName === 'ApproximateNumberOfMessagesVisible' &&
        dims.some((d) => d.Name === 'QueueName');
      const hasActions =
        Array.isArray(r.Properties?.AlarmActions) && r.Properties.AlarmActions.length > 0;
      return isSqsDepth && hasActions;
    });
    expect(dlqAlarmsWithActions).toHaveLength(3);
    // Each action must reference the operational-alerts topic.
    for (const alarm of dlqAlarmsWithActions) {
      expect(JSON.stringify((alarm as any).Properties.AlarmActions)).toContain('OperationalAlerts');
    }
  });

  test('does NOT subscribe an email when no alertEmail context is set (#629)', () => {
    // The default deploy ships the topic with no confirmed target;
    // operators subscribe Slack / PagerDuty / email themselves.
    template.resourceCountIs('AWS::SNS::Subscription', 0);
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
    // Two task defs — the 64 GB build def and the 8 GB read-only planning def
    // (a read-only workflow runs on the smaller one). See
    // docs/design/ECS_RIGHTSIZED_PLANNING.md.
    template.resourceCountIs('AWS::ECS::TaskDefinition', 2);
  });

  test('outputs ComputeSubstrate=ecs so the CLI allows compute_type=ecs onboarding', () => {
    template.hasOutput('ComputeSubstrate', { Value: 'ecs' });
  });

  test('the orchestrator gets the PLANNING task-def ARN, not just the build one', () => {
    // Without this env var the ECS strategy's `readOnly &&
    // ECS_PLANNING_TASK_DEFINITION_ARN` guard is always falsy, so the planning
    // def would be synthesized, billed for, and never receive a workflow — the
    // feature inert while looking present in the template.
    //
    // This has to be asserted at the STACK level. The strategy's own unit tests
    // set the env var by hand to exercise the routing branch, so they pass
    // whether or not anything in the stack actually supplies it; only synth can
    // tell us the wiring exists. Both ARNs are asserted together because the bug
    // this pins is one being present without the other.
    const envs = Object.values(
      template.findResources('AWS::Lambda::Function'),
    ).map(fn => fn.Properties?.Environment?.Variables ?? {});
    const orchestrator = envs.filter(e => 'ECS_TASK_DEFINITION_ARN' in e);
    expect(orchestrator).toHaveLength(1);
    expect(orchestrator[0]).toHaveProperty('ECS_PLANNING_TASK_DEFINITION_ARN');
    // ...and the two must be DIFFERENT task defs, or read-only workflows are
    // silently running on the build box anyway.
    expect(orchestrator[0].ECS_PLANNING_TASK_DEFINITION_ARN)
      .not.toEqual(orchestrator[0].ECS_TASK_DEFINITION_ARN);
  });

  test('build-task sizing is reachable from deploy context, not only from the construct', () => {
    // The construct's default is deliberately modest so an adopter who changes
    // nothing does not pay for the Fargate ceiling. That is only defensible if a
    // heavy monorepo can RAISE it without editing the construct — and `taskSizing`
    // had no caller at all, so the ceiling was unreachable by any supported route.
    // This asserts the whole path: context -> resolver -> construct -> template.
    const app = new App({
      context: {
        compute_type: 'ecs',
        ecsBuildTaskCpu: '16384',
        ecsBuildTaskMemoryMiB: '122880',
        ecsBuildTaskEphemeralStorageGiB: '100',
      },
    });
    const sized = Template.fromStack(new AgentStack(app, 'SizedEcsStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    }));
    sized.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '16384',
      Memory: '122880',
      EphemeralStorage: { SizeInGiB: 100 },
    });
  });

  test('the DEFAULT ECS build task stays modest', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '4096',
      Memory: '16384',
    });
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

  test('provisions the MicroVM image + BOTH egress network connectors', () => {
    template.resourceCountIs('AWS::Lambda::MicrovmImage', 1);
    // Runtime (443) + build-time (443 + 80, for apt-get) — see ADR-021's
    // build-time-egress security-table row.
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 2);
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
      // The script passes THIS one to create-microvm-image: the runtime
      // connector is 443-only and the Dockerfile's apt-get needs port 80.
      'MicrovmBuildEgressConnectorArns',
      'MicrovmLogGroupName',
    ]) {
      template.hasOutput(output, {});
    }
  });

  test('the build and runtime egress connector outputs are DIFFERENT connectors', () => {
    const outputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(JSON.stringify(outputs.MicrovmEgressConnectorArns.Value))
      .not.toEqual(JSON.stringify(outputs.MicrovmBuildEgressConnectorArns.Value));
  });

  test('injects the MICROVM_* env vars the strategy reads, including explicit NO_INGRESS', () => {
    const fns = template.findResources('AWS::Lambda::Function');
    const [, orchestrator] = Object.entries(fns)
      .find(([id]) => id.includes('TaskOrchestratorOrchestratorFn'))!;
    const env = orchestrator.Properties.Environment.Variables as Record<string, unknown>;

    expect(Object.keys(env).filter(k => k.startsWith('MICROVM_')).sort()).toEqual([
      'MICROVM_EGRESS_CONNECTOR_ARNS',
      'MICROVM_EXECUTION_ROLE_ARN',
      'MICROVM_IMAGE_IDENTIFIER',
      'MICROVM_INGRESS_CONNECTOR_ARNS',
      'MICROVM_PAYLOAD_BUCKET',
    ]);
    // Image version is deliberately unpinned.
    expect(env.MICROVM_IMAGE_VERSION).toBeUndefined();
    // Ingress is NOT empty and NOT omitted: RunMicrovm attaches a PUBLIC
    // HTTP_INGRESS connector (with a public endpoint) when the field is absent,
    // so "no inbound" is an explicit control on every launch.
    expect(JSON.stringify(env.MICROVM_INGRESS_CONNECTOR_ARNS)).toContain('NO_INGRESS');
    expect(JSON.stringify(env.MICROVM_INGRESS_CONNECTOR_ARNS)).not.toContain('HTTP_INGRESS');
  });

  test('MICROVM_IMAGE_IDENTIFIER is the image ARN, not a bare name', () => {
    // RunMicrovm rejects a bare name ("Malformed ARN - doesn't start with
    // 'arn:'"), so the identifier the orchestrator receives must be the same ARN
    // the lifecycle IAM grant is scoped to.
    const fns = template.findResources('AWS::Lambda::Function');
    const [, orchestrator] = Object.entries(fns)
      .find(([id]) => id.includes('TaskOrchestratorOrchestratorFn'))!;
    const env = orchestrator.Properties.Environment.Variables as Record<string, unknown>;
    expect(JSON.stringify(env.MICROVM_IMAGE_IDENTIFIER))
      .toMatch(/"Fn::GetAtt":\["LambdaMicrovmComputeImage[^"]*","ImageArn"\]/);
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

  test('wires the P2 runtime-parity grants onto the MicroVM execution role', () => {
    // Construct-level scoping is asserted in test/constructs/lambda-microvm-compute
    // test; what only the STACK can get wrong is passing the props at all — a
    // missing `githubTokenSecret` or `agentMemory` here synthesizes cleanly and
    // fails at run time (no clone / silently-dropped memory writes).
    const policies = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole')),
    );
    // The platform GitHub PAT secret, by reference to the real stack secret.
    expect(policies).toContain('secretsmanager:GetSecretValue');
    expect(policies).toContain('GitHubTokenSecret');
    // AgentCore Memory, so cross-task learning persists on this substrate.
    expect(policies).toContain('bedrock-agentcore:CreateEvent');
    // Bedrock, scoped to the shared model list rather than a wildcard.
    expect(policies).toContain('bedrock:InvokeModel');
    expect(policies).toContain('inference-profile/us.anthropic.claude-opus-4-8');
    // Tenant data stays on the SessionRole: no direct DynamoDB, ever.
    expect(policies).not.toContain('dynamodb:');
    expect(policies).toContain('sts:TagSession');
  });

  test('grants the MicroVM execution role writes on the SAME log group platform_config names', () => {
    // ADR-021 P2-F4, and a stack-level property by construction: the construct can
    // only grant against the log group the stack hands it, and the orchestrator can
    // only deliver the name the stack puts in `agentPlatformConfig`. If those two
    // ever came from different objects the deploy would still succeed and every
    // per-task log line would AccessDenied — which is exactly what the live P2 run
    // hit. So this asserts they are the SAME logical resource.
    const policies = JSON.stringify(
      Object.entries(template.findResources('AWS::IAM::Policy'))
        .filter(([id]) => id.includes('LambdaMicrovmComputeExecutionRole')),
    );
    expect(policies).toContain('logs:CreateLogStream');
    expect(policies).toContain('RuntimeApplicationLogGroup');

    // ...and the orchestrator delivers that group's NAME as LOG_GROUP_NAME.
    const orchestrator = Object.entries(template.findResources('AWS::Lambda::Function'))
      .find(([id]) => id.includes('TaskOrchestratorOrchestratorFn'))!;
    const logGroupEnv = JSON.stringify(
      orchestrator[1].Properties.Environment.Variables.LOG_GROUP_NAME,
    );
    expect(logGroupEnv).toContain('RuntimeApplicationLogGroup');
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

  test('provisions the substrate (buckets, roles, both connectors) but no image', () => {
    template.resourceCountIs('AWS::Lambda::NetworkConnector', 2);
    template.resourceCountIs('AWS::Lambda::MicrovmImage', 0);
    template.hasOutput('MicrovmArtifactBucketName', {});
    // The build-time connector output is what the packaging script reads next, so
    // it must exist in exactly this pre-image state.
    template.hasOutput('MicrovmBuildEgressConnectorArns', {});
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

describe('AgentStack solution attribution (#319): AWS_SDK_UA_APP_ID via stack-level aspect', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new AgentStack(app, 'UaAgentStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    // Mirror main.ts: the SolutionUaAspect is applied at the stack scope, not
    // inside AgentStack. It must reach every Lambda in the tree — including the
    // ones nested several construct levels deep (integrations, orchestrator),
    // not just functions declared directly under the stack.
    Aspects.of(stack).add(new SolutionUaAspect(buildAppId('UaAgentStack')), {
      priority: AspectPriority.MUTATING,
    });
    template = Template.fromStack(stack);
  });

  // CDK synthesizes its own framework-owned Lambdas that are NOT part of the
  // ABCA solution surface: the S3 auto-delete and VPC default-SG-restriction
  // custom-resource provider handlers (CfnResource-backed, so the aspect's
  // `instanceof lambda.Function` guard cannot visit them), plus the
  // `AWS679f53fac002430cb0da5b7982bd2287…` `cr.AwsCustomResource` singleton
  // (which CDK happens to give the env var today, but whose attribution we do
  // not want to depend on across CDK upgrades). Every framework-owned id is
  // enumerated explicitly so the coverage assertion below cannot silently
  // stop covering an ABCA Lambda by relabelling it as "framework".
  const FRAMEWORK_LAMBDA_ID =
    /^(CustomResourceProviderHandler|CustomS3AutoDeleteObjects|CustomVpcRestrictDefaultSG|AWS679f53fac002430cb0da5b7982bd2287)/;

  test('every solution Lambda carries AWS_SDK_UA_APP_ID (traverses nested scope)', () => {
    const functions = template.findResources('AWS::Lambda::Function');
    const abcaLambdas = Object.entries(functions).filter(
      ([id]) => !FRAMEWORK_LAMBDA_ID.test(id),
    );
    // exact count — update when adding/removing a Lambda construct (#319).
    // A loose `toBeGreaterThan` let a whole integration construct disappear
    // unnoticed; the exact count fails if a Lambda is dropped OR if a new one
    // is added without being attributed below.
    expect(abcaLambdas.length).toBe(46);
    // Every ABCA-authored Lambda must carry the canonical `#` app-id. Collect
    // any offenders so a failure names the exact logical id(s) that are naked.
    const unattributed = abcaLambdas
      .filter(
        ([, fn]) =>
          fn.Properties?.Environment?.Variables?.AWS_SDK_UA_APP_ID !==
          'uksb-wt64nei4u6#UaAgentStack',
      )
      .map(([id]) => id);
    expect(unattributed).toEqual([]);
  });

  test('nested integration Lambdas (Jira/Slack/Linear) inherit the app-id', () => {
    // The trap: these functions live inside integration constructs several
    // scopes below the stack. The env-var still resolves the canonical `#`
    // form (not the mangled `-` variant).
    const functions = template.findResources('AWS::Lambda::Function');
    const nested = Object.entries(functions).filter(([id]) =>
      /Jira|Slack|Linear/.test(id),
    );
    expect(nested.length).toBeGreaterThan(0);
    for (const [, fn] of nested) {
      expect(fn.Properties.Environment?.Variables?.AWS_SDK_UA_APP_ID).toBe('uksb-wt64nei4u6#UaAgentStack');
    }
  });
});

describe('AgentStack tool-gateway gate (ADR-019 P1)', () => {
  test('default (no-gate) synth provisions NO Gateway — synth stays byte-unchanged', () => {
    // The whole ToolGateway construct is context-gated; without the flag the
    // template must contain zero Gateway/GatewayTarget resources so the default
    // deploy is untouched and no new CFN type enters the bootstrap coverage set.
    const app = new App();
    const stack = new AgentStack(app, 'NoGatewayStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);
    template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 0);
    template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 0);
  });

  describe('with --context enableToolGateway=true', () => {
    let template: Template;

    beforeAll(() => {
      const app = new App({ context: { enableToolGateway: true } });
      const stack = new AgentStack(app, 'GatewayStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      template = Template.fromStack(stack);
    });

    test('provisions exactly one AWS_IAM Gateway + one Lambda target', () => {
      template.resourceCountIs('AWS::BedrockAgentCore::Gateway', 1);
      template.hasResourceProperties('AWS::BedrockAgentCore::Gateway', {
        AuthorizerType: 'AWS_IAM',
      });
      template.resourceCountIs('AWS::BedrockAgentCore::GatewayTarget', 1);
    });

    test('the AgentCore runtime carries ABCA_TOOL_GATEWAY_URL', () => {
      template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
        EnvironmentVariables: Match.objectLike({
          ABCA_TOOL_GATEWAY_URL: Match.anyValue(),
        }),
      });
    });
  });

  describe('substrate parity: with BOTH --context enableToolGateway=true AND compute_type=ecs', () => {
    // #641 requires the federated tool to work on BOTH substrates. The
    // AgentCore-runtime wiring is asserted above; without these two the ECS
    // task could ship with no gateway URL and no InvokeGateway grant — the tool
    // silently absent on Fargate while looking present in the AgentCore path.
    // This is the both-substrates acceptance bar the ADR-019 review called out.
    let template: Template;

    beforeAll(() => {
      const app = new App({
        context: { enableToolGateway: true, compute_type: 'ecs' },
      });
      const stack = new AgentStack(app, 'GatewayEcsStack', {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      template = Template.fromStack(stack);
    });

    test('every ECS task definition container carries ABCA_TOOL_GATEWAY_URL', () => {
      // Both the build and planning task defs share the base container env, so
      // each must carry the gateway URL — assert on all of them, not just one.
      const taskDefs = Object.values(
        template.findResources('AWS::ECS::TaskDefinition'),
      );
      expect(taskDefs.length).toBeGreaterThan(0);
      for (const taskDef of taskDefs) {
        const containers = taskDef.Properties?.ContainerDefinitions ?? [];
        const withGatewayUrl = containers.filter(
          (c: { Environment?: { Name: string }[] }) =>
            (c.Environment ?? []).some((e) => e.Name === 'ABCA_TOOL_GATEWAY_URL'),
        );
        expect(withGatewayUrl.length).toBeGreaterThan(0);
      }
    });

    test('the ECS task role is granted bedrock-agentcore:InvokeGateway', () => {
      // Scope the assertion to the ECS TASK role. The AgentCore runtime role is
      // granted the same InvokeGateway action in this very template, so an
      // unscoped `hasResourceProperties` would stay green even if the ECS
      // grant (ecs-agent-cluster.ts:554) were deleted — precisely the
      // cross-substrate regression this test exists to catch. Pin the policy to
      // the EcsAgentCluster TaskRole via its `Roles` attachment.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'bedrock-agentcore:InvokeGateway',
              Effect: 'Allow',
            }),
          ]),
        }),
        Roles: Match.arrayWith([
          Match.objectLike({
            Ref: Match.stringLikeRegexp('EcsAgentClusterTaskRole'),
          }),
        ]),
      });
    });
  });
});

describe('AgentStack Agent Registry gate', () => {
  test.each([undefined, true, 'true'])(
    'enableAgentRegistry=%p includes the registry by default or explicit enablement',
    (enableAgentRegistry) => {
      const context = enableAgentRegistry === undefined ? {} : { enableAgentRegistry };
      const app = new App({ context });
      const stack = new AgentStack(app, `AgentRegistryStack${String(enableAgentRegistry)}`, {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const nestedStackIds = Object.keys(
        Template.fromStack(stack).findResources('AWS::CloudFormation::Stack'),
      );

      expect(nestedStackIds.some(id => id.includes('AgentRegistryStack'))).toBe(true);
    },
  );

  test.each([false, 'false'])(
    'enableAgentRegistry=%p omits registry resources, wiring, and outputs',
    (enableAgentRegistry) => {
      const app = new App({ context: { enableAgentRegistry } });
      const stack = new AgentStack(app, `NoAgentRegistryStack${typeof enableAgentRegistry}`, {
        env: { account: '123456789012', region: 'us-east-1' },
      });
      const template = Template.fromStack(stack);
      const rendered = template.toJSON();
      const nestedStackIds = Object.keys(template.findResources('AWS::CloudFormation::Stack'));
      const outputs = rendered.Outputs ?? {};

      expect(nestedStackIds.some(id => id.includes('AgentRegistryStack'))).toBe(false);
      expect(nestedStackIds.some(id => id.includes('RegistryApi'))).toBe(false);
      expect(outputs).not.toHaveProperty('AgentRegistryId');
      expect(outputs).not.toHaveProperty('AgentRegistryArn');
      expect(outputs).not.toHaveProperty('RegistryApiUrl');

      for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) {
        expect(fn.Properties?.Environment?.Variables ?? {}).not.toHaveProperty('AGENT_REGISTRY_ID');
      }

      for (const policy of Object.values(template.findResources('AWS::IAM::Policy'))) {
        const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
        for (const statement of statements) {
          expect(JSON.stringify(statement.Action)).not.toContain('agent-registry:');
        }
      }
    },
  );

  test('rejects malformed enableAgentRegistry context values', () => {
    const app = new App({ context: { enableAgentRegistry: 'fasle' } });

    expect(() => new AgentStack(app, 'InvalidAgentRegistryContext', {
      env: { account: '123456789012', region: 'us-east-1' },
    })).toThrow("enableAgentRegistry must be true or false, got 'fasle'");
  });
});
