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

import { Annotations, Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct, IValidation } from 'constructs';
// Cross-language constants (S9 — see ``contracts/constants.md``). Import
// the JSON directly rather than re-using ``handlers/shared/types.ts`` so
// the construct layer stays decoupled from runtime-side types.
import sharedConstants from '../../../contracts/constants.json';
import { parseRef } from '../handlers/shared/registry/ref';

const REPO_PATTERN = /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;
const DOMAIN_PATTERN = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Cedar HITL — bounds on the per-task approval-gate cap (design decision #13).
 * Single source of truth: ``contracts/constants.json``. Same JSON is read
 * by ``agent/src/policy.py`` at import and re-exported from
 * ``handlers/shared/types.ts``.
 */
const APPROVAL_GATE_CAP_MIN = sharedConstants.approval_gate_cap.min;
const APPROVAL_GATE_CAP_MAX = sharedConstants.approval_gate_cap.max;

/**
 * Bounds on a per-repo cost budget (#748). Same JSON the task-submit path
 * validates ``max_budget_usd`` against (``handlers/shared/types.ts`` →
 * ``MAX_BUDGET_USD_MIN``/``MAX_BUDGET_USD_MAX``, used by
 * ``cli/src/commands/submit.ts``). Reading the shared constants rather than
 * re-declaring literals is what keeps the per-repo default and the per-task
 * override from disagreeing about what is in range.
 */
const MAX_BUDGET_USD_MIN = sharedConstants.max_budget_usd.min;
const MAX_BUDGET_USD_MAX = sharedConstants.max_budget_usd.max;

/** Timeout for the RepoConfig custom resource (minutes). */
const REPO_CONFIG_CR_TIMEOUT_MINUTES = 5;

/** TTL (days) applied to a RepoConfig row on blueprint delete before cleanup. */
const REMOVED_REPO_TTL_DAYS = 30;

/**
 * Properties for the Blueprint construct.
 */
export interface BlueprintProps {
  /**
   * Repository identifier in "owner/repo" format.
   */
  readonly repo: string;

  /**
   * The shared RepoTable DynamoDB table.
   */
  readonly repoTable: dynamodb.ITable;

  /**
   * Compute strategy configuration.
   */
  readonly compute?: {
    /**
     * Compute strategy type.
     * @default 'agentcore'
     */
    readonly type?: 'agentcore' | 'ecs';

    /**
     * Override the default runtime ARN (agentcore strategy).
     */
    readonly runtimeArn?: string;
  };

  /**
   * Agent configuration overrides.
   */
  readonly agent?: {
    /**
     * Foundation model ID override.
     */
    readonly modelId?: string;

    /**
     * Default turn limit for tasks against this repo.
     */
    readonly maxTurns?: number;

    /**
     * Default cost budget in USD for tasks against this repo (#748).
     *
     * A per-task ``max_budget_usd`` (REST) / ``--max-budget`` (CLI) wins over
     * this value; when neither is set NO budget applies (there is no platform
     * default — unset means unlimited, deliberately).
     *
     * Must be in ``[0.01, 100]`` — the same range the task-submit path
     * enforces, so a per-repo default cannot be a value a per-task override
     * would have rejected. Out-of-range values fail at synth.
     */
    readonly maxBudgetUsd?: number;

    /**
     * Additional system prompt instructions appended to the platform default.
     */
    readonly systemPromptOverrides?: string;
  };

  /**
   * Credential configuration.
   */
  readonly credentials?: {
    /**
     * ARN of the Secrets Manager secret containing a per-repo GitHub token.
     */
    readonly githubTokenSecretArn?: string;
  };

  /**
   * Pipeline customization.
   */
  readonly pipeline?: {
    /**
     * Override the default poll interval (ms) for awaiting agent completion.
     */
    readonly pollIntervalMs?: number;

    /**
     * Command the agent runs to BUILD/verify the repo before opening a PR
     * (and as the pre-change baseline). Drives build-regression gating: if
     * the repo built green before the agent's change and fails after, the
     * task fails. Defaults to ``mise run build`` when unset.
     *
     * Set this for repos that do NOT use mise (e.g. ``'npm run build'``,
     * ``'gradle build'``, ``'make'``). Without a runnable build command,
     * build-regression gating is INERT — a change that breaks the build
     * still reports success (the agent emits a one-time warning on the PR).
     * Runs in the agent's cloud container against the cloned repo; this is a
     * compile/test verification, NOT a deployment.
     */
    readonly buildCommand?: string;

    /**
     * Command the agent runs to LINT the repo (advisory gate). Defaults to
     * ``mise run lint`` when unset. Same semantics as ``buildCommand``.
     */
    readonly lintCommand?: string;
  };

  /**
   * Security configuration.
   */
  readonly security?: {
    /**
     * Additional Cedar policy strings evaluated by the agent's PolicyEngine.
     * These are appended to the default policies (deny-list model).
     */
    readonly cedarPolicies?: string[];

    /**
     * Per-task cap on total approval gates (Cedar HITL decision #13,
     * design §4 step 5). Captured at task-submit time and persisted on
     * the TaskRecord so the cap is frozen per-task — mid-task blueprint
     * edits do NOT shift the cap beneath a running task.
     *
     * Must be in ``[1, 500]``. When omitted, submit-time resolution falls
     * back to the platform default of 50 defined in the handler layer.
     */
    readonly approvalGateCap?: number;
  };

  /**
   * Network configuration for the agent.
   */
  readonly networking?: {
    /**
     * Additional domains the agent is allowed to resolve.
     * These feed the platform-wide DNS Firewall allowlist (not per-session enforcement).
     * Each entry must be a valid domain (e.g. 'npm.internal.example.com')
     * or a wildcard domain (e.g. '*.internal.example.com').
     */
    readonly egressAllowlist?: string[];
  };

  /**
   * Registry assets (#246) this repo pins. Each entry is a strict
   * ``registry://kind/namespace/name@constraint`` ref, validated at synth. The
   * orchestrator resolves the refs at task start and threads the resolved bundle
   * into the agent payload; an unresolvable ref fails the task (fail-closed).
   */
  readonly assets?: {
    /** MCP servers merged into the agent's ``.mcp.json`` (PR 2). */
    readonly mcpServers?: string[];
    /** Cedar policy modules concatenated into the agent's cedar_policies (PR 3). */
    readonly cedarPolicyModules?: string[];
    /** Skills whose prompt fragments are appended to the system prompt (PR 3). */
    readonly skills?: string[];
  };
}

/**
 * CDK construct that registers a repository with the platform by writing
 * a RepoConfig record to the shared RepoTable via a custom resource.
 *
 * Create: PutItem with status='active' and all config fields. Update: UpdateItem,
 * which SETs the fields a Blueprint declares and REMOVEs the per-repo overrides it
 * no longer declares — a SET-only update would leave a dropped override live.
 * Delete: UpdateItem to set status='removed' and TTL for eventual cleanup.
 *
 * NOTE: Timestamps (onboarded_at, updated_at) are captured at CDK synth time,
 * not CloudFormation deploy time. This is an inherent limitation of AwsCustomResource
 * where parameters are baked into the template. For precise deploy-time timestamps,
 * a full custom resource Lambda would be needed.
 */
export class Blueprint extends Construct {
  /**
   * Domains from the networking.egressAllowlist prop, exposed for aggregation
   * into the platform-wide DNS Firewall allowlist.
   */
  public readonly egressAllowlist: readonly string[];

  /**
   * Cedar policies from the security.cedarPolicies prop, exposed for inspection.
   */
  public readonly cedarPolicies: readonly string[];

  /**
   * Cedar HITL: per-task approval-gate cap from the security.approvalGateCap
   * prop, exposed for inspection. Undefined when the blueprint did not
   * configure an override — the submit path then falls back to the
   * platform default of 50.
   */
  public readonly approvalGateCap?: number;

  /**
   * Per-repo cost budget in USD from the agent.maxBudgetUsd prop (#748),
   * exposed for inspection. Undefined when the blueprint did not configure
   * one — there is no platform default, so unset means unlimited.
   */
  public readonly maxBudgetUsd?: number;

  /**
   * Registry ``registry://`` refs for MCP servers (#246), exposed for inspection.
   */
  public readonly mcpServerRefs: readonly string[];

  /** Registry ``registry://`` refs for Cedar policy modules (#246). */
  public readonly cedarPolicyModuleRefs: readonly string[];

  /** Registry ``registry://`` refs for skills (#246). */
  public readonly skillRefs: readonly string[];

  constructor(scope: Construct, id: string, props: BlueprintProps) {
    super(scope, id);

    this.egressAllowlist = [...(props.networking?.egressAllowlist ?? [])];
    this.cedarPolicies = [...(props.security?.cedarPolicies ?? [])];
    this.approvalGateCap = props.security?.approvalGateCap;
    this.maxBudgetUsd = props.agent?.maxBudgetUsd;
    this.mcpServerRefs = [...(props.assets?.mcpServers ?? [])];
    this.cedarPolicyModuleRefs = [...(props.assets?.cedarPolicyModules ?? [])];
    this.skillRefs = [...(props.assets?.skills ?? [])];

    // Chunk 7c: emit a synth-time info annotation when the blueprint did
    // not configure an override so operators see a signal that this repo
    // will rely on the platform-default cap (50). Without this, the only
    // way to notice the default was in effect was to inspect the TaskRecord
    // at runtime — the default is a silent fallback at the handler layer.
    if (this.approvalGateCap === undefined) {
      Annotations.of(this).addInfo(
        `security.approvalGateCap not configured for '${props.repo}'; `
        + 'submit-time resolution will fall back to the platform default of 50. '
        + 'Set security.approvalGateCap on the Blueprint to override.',
      );
    }

    // Validate repo format at construct time
    this.node.addValidation(new RepoFormatValidation(props.repo));
    this.node.addValidation(new DomainFormatValidation(this.egressAllowlist));
    this.node.addValidation(new ApprovalGateCapValidation(this.approvalGateCap));
    this.node.addValidation(new MaxBudgetUsdValidation(this.maxBudgetUsd));
    this.node.addValidation(new RegistryRefValidation('assets.mcpServers', this.mcpServerRefs, 'mcp_server'));
    this.node.addValidation(new RegistryRefValidation('assets.cedarPolicyModules', this.cedarPolicyModuleRefs, 'cedar_policy_module'));
    this.node.addValidation(new RegistryRefValidation('assets.skills', this.skillRefs, 'skill'));

    const now = new Date().toISOString();

    // Build the DynamoDB item for PutItem
    const item: Record<string, unknown> = {
      repo: { S: props.repo },
      status: { S: 'active' },
      onboarded_at: { S: now },
      updated_at: { S: now },
    };

    if (props.compute?.type) {
      item.compute_type = { S: props.compute.type };
    }
    if (props.compute?.runtimeArn) {
      item.runtime_arn = { S: props.compute.runtimeArn };
    }
    if (props.agent?.modelId) {
      item.model_id = { S: props.agent.modelId };
    }
    if (props.agent?.maxTurns !== undefined) {
      item.max_turns = { N: String(props.agent.maxTurns) };
    }
    if (this.maxBudgetUsd !== undefined) {
      item.max_budget_usd = { N: String(this.maxBudgetUsd) };
    }
    if (props.agent?.systemPromptOverrides) {
      item.system_prompt_overrides = { S: props.agent.systemPromptOverrides };
    }
    if (props.credentials?.githubTokenSecretArn) {
      item.github_token_secret_arn = { S: props.credentials.githubTokenSecretArn };
    }
    if (props.pipeline?.pollIntervalMs !== undefined) {
      item.poll_interval_ms = { N: String(props.pipeline.pollIntervalMs) };
    }
    if (props.pipeline?.buildCommand) {
      item.build_command = { S: props.pipeline.buildCommand };
    }
    if (props.pipeline?.lintCommand) {
      item.lint_command = { S: props.pipeline.lintCommand };
    }
    if (this.egressAllowlist.length > 0) {
      item.egress_allowlist = { L: this.egressAllowlist.map(d => ({ S: d })) };
    }
    if (this.cedarPolicies.length > 0) {
      item.cedar_policies = { L: this.cedarPolicies.map(p => ({ S: p })) };
    }
    if (this.approvalGateCap !== undefined) {
      item.approval_gate_cap = { N: String(this.approvalGateCap) };
    }
    if (this.mcpServerRefs.length > 0) {
      item.mcp_servers = { L: this.mcpServerRefs.map(r => ({ S: r })) };
    }
    if (this.cedarPolicyModuleRefs.length > 0) {
      item.cedar_policy_modules = { L: this.cedarPolicyModuleRefs.map(r => ({ S: r })) };
    }
    if (this.skillRefs.length > 0) {
      item.skills = { L: this.skillRefs.map(r => ({ S: r })) };
    }

    new cr.AwsCustomResource(this, 'RepoConfigCR', {
      timeout: Duration.minutes(REPO_CONFIG_CR_TIMEOUT_MINUTES),
      onCreate: {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: {
          TableName: props.repoTable.tableName,
          Item: item,
        },
        physicalResourceId: cr.PhysicalResourceId.of(`blueprint-${props.repo}`),
      },
      onUpdate: {
        service: 'DynamoDB',
        action: 'updateItem',
        parameters: {
          TableName: props.repoTable.tableName,
          Key: { repo: { S: props.repo } },
          UpdateExpression: `SET #status = :active, #updated = :now${this.buildUpdateFields(props)}${this.buildRemoveClause(props)}`,
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updated': 'updated_at',
            ...this.buildExpressionNames(props),
            ...this.buildRemoveNames(props),
          },
          ExpressionAttributeValues: {
            ':active': { S: 'active' },
            ':now': { S: new Date().toISOString() },
            ...this.buildExpressionValues(props),
          },
        },
        physicalResourceId: cr.PhysicalResourceId.of(`blueprint-${props.repo}`),
      },
      onDelete: {
        service: 'DynamoDB',
        action: 'updateItem',
        parameters: {
          TableName: props.repoTable.tableName,
          Key: { repo: { S: props.repo } },
          UpdateExpression: 'SET #status = :removed, #updated = :now, #ttl = :ttl',
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updated': 'updated_at',
            '#ttl': 'ttl',
          },
          ExpressionAttributeValues: {
            ':removed': { S: 'removed' },
            ':now': { S: new Date().toISOString() },
            ':ttl': { N: String(Math.floor(Date.now() / 1000) + REMOVED_REPO_TTL_DAYS * 86400) },
          },
        },
      },
      policy: cr.AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
          resources: [props.repoTable.tableArn],
        }),
      ]),
    });
  }

  private buildUpdateFields(props: BlueprintProps): string {
    const fields: string[] = [];
    if (props.compute?.type) fields.push(', #compute_type = :compute_type');
    if (props.compute?.runtimeArn) fields.push(', #runtime_arn = :runtime_arn');
    if (props.agent?.modelId) fields.push(', #model_id = :model_id');
    if (props.agent?.maxTurns !== undefined) fields.push(', #max_turns = :max_turns');
    if (this.maxBudgetUsd !== undefined) fields.push(', #max_budget_usd = :max_budget_usd');
    if (props.agent?.systemPromptOverrides) fields.push(', #system_prompt_overrides = :system_prompt_overrides');
    if (props.credentials?.githubTokenSecretArn) fields.push(', #github_token_secret_arn = :github_token_secret_arn');
    if (props.pipeline?.pollIntervalMs !== undefined) fields.push(', #poll_interval_ms = :poll_interval_ms');
    if (props.pipeline?.buildCommand) fields.push(', #build_command = :build_command');
    if (props.pipeline?.lintCommand) fields.push(', #lint_command = :lint_command');
    if (this.egressAllowlist.length > 0) fields.push(', #egress_allowlist = :egress_allowlist');
    if (this.cedarPolicies.length > 0) fields.push(', #cedar_policies = :cedar_policies');
    if (this.approvalGateCap !== undefined) fields.push(', #approval_gate_cap = :approval_gate_cap');
    // Registry asset refs (#246) — must mirror onCreate's item, else a redeploy
    // of an already-onboarded repo silently drops asset-ref changes.
    if (this.mcpServerRefs.length > 0) fields.push(', #mcp_servers = :mcp_servers');
    if (this.cedarPolicyModuleRefs.length > 0) fields.push(', #cedar_policy_modules = :cedar_policy_modules');
    if (this.skillRefs.length > 0) fields.push(', #skills = :skills');
    return fields.join('');
  }

  private buildExpressionNames(props: BlueprintProps): Record<string, string> {
    const names: Record<string, string> = {};
    if (props.compute?.type) names['#compute_type'] = 'compute_type';
    if (props.compute?.runtimeArn) names['#runtime_arn'] = 'runtime_arn';
    if (props.agent?.modelId) names['#model_id'] = 'model_id';
    if (props.agent?.maxTurns !== undefined) names['#max_turns'] = 'max_turns';
    if (this.maxBudgetUsd !== undefined) names['#max_budget_usd'] = 'max_budget_usd';
    if (props.agent?.systemPromptOverrides) names['#system_prompt_overrides'] = 'system_prompt_overrides';
    if (props.credentials?.githubTokenSecretArn) names['#github_token_secret_arn'] = 'github_token_secret_arn';
    if (props.pipeline?.pollIntervalMs !== undefined) names['#poll_interval_ms'] = 'poll_interval_ms';
    if (props.pipeline?.buildCommand) names['#build_command'] = 'build_command';
    if (props.pipeline?.lintCommand) names['#lint_command'] = 'lint_command';
    if (this.egressAllowlist.length > 0) names['#egress_allowlist'] = 'egress_allowlist';
    if (this.cedarPolicies.length > 0) names['#cedar_policies'] = 'cedar_policies';
    if (this.approvalGateCap !== undefined) names['#approval_gate_cap'] = 'approval_gate_cap';
    if (this.mcpServerRefs.length > 0) names['#mcp_servers'] = 'mcp_servers';
    if (this.cedarPolicyModuleRefs.length > 0) names['#cedar_policy_modules'] = 'cedar_policy_modules';
    if (this.skillRefs.length > 0) names['#skills'] = 'skills';
    return names;
  }

  private buildExpressionValues(props: BlueprintProps): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    if (props.compute?.type) values[':compute_type'] = { S: props.compute.type };
    if (props.compute?.runtimeArn) values[':runtime_arn'] = { S: props.compute.runtimeArn };
    if (props.agent?.modelId) values[':model_id'] = { S: props.agent.modelId };
    if (props.agent?.maxTurns !== undefined) values[':max_turns'] = { N: String(props.agent.maxTurns) };
    if (this.maxBudgetUsd !== undefined) values[':max_budget_usd'] = { N: String(this.maxBudgetUsd) };
    if (props.agent?.systemPromptOverrides) values[':system_prompt_overrides'] = { S: props.agent.systemPromptOverrides };
    if (props.credentials?.githubTokenSecretArn) values[':github_token_secret_arn'] = { S: props.credentials.githubTokenSecretArn };
    if (props.pipeline?.pollIntervalMs !== undefined) values[':poll_interval_ms'] = { N: String(props.pipeline.pollIntervalMs) };
    if (props.pipeline?.buildCommand) values[':build_command'] = { S: props.pipeline.buildCommand };
    if (props.pipeline?.lintCommand) values[':lint_command'] = { S: props.pipeline.lintCommand };
    if (this.egressAllowlist.length > 0) values[':egress_allowlist'] = { L: this.egressAllowlist.map(d => ({ S: d })) };
    if (this.cedarPolicies.length > 0) values[':cedar_policies'] = { L: this.cedarPolicies.map(p => ({ S: p })) };
    if (this.approvalGateCap !== undefined) values[':approval_gate_cap'] = { N: String(this.approvalGateCap) };
    if (this.mcpServerRefs.length > 0) values[':mcp_servers'] = { L: this.mcpServerRefs.map(r => ({ S: r })) };
    if (this.cedarPolicyModuleRefs.length > 0) values[':cedar_policy_modules'] = { L: this.cedarPolicyModuleRefs.map(r => ({ S: r })) };
    if (this.skillRefs.length > 0) values[':skills'] = { L: this.skillRefs.map(r => ({ S: r })) };
    return values;
  }

  /** Registry asset fields that are now empty must be REMOVEd on update, not
   *  just omitted from SET — otherwise a redeploy that cleared the last
   *  mcp_server/cedar_policy_module/skill leaves the stale DDB refs active and
   *  operators can't detach a pinned asset through the Blueprint API (#246). */
  private emptyAssetFields(): string[] {
    const empty: string[] = [];
    if (this.mcpServerRefs.length === 0) empty.push('mcp_servers');
    if (this.cedarPolicyModuleRefs.length === 0) empty.push('cedar_policy_modules');
    if (this.skillRefs.length === 0) empty.push('skills');
    return empty;
  }

  /** Per-repo overrides to clear when their prop is dropped.
   *
   *  EMPTY, deliberately, and this is the second attempt at it. Clearing `model_id`
   *  when a Blueprint declares no `agent.modelId` looked symmetric with the asset
   *  refs above, but it is not: `onUpdate`'s parameters embed a synth-time timestamp,
   *  so CloudFormation issues an Update on EVERY deploy, and `bgagent repo onboard
   *  --model` is a sanctioned second writer of this same row (ADR-017) that
   *  deliberately carries the value forward. The clear therefore deleted an
   *  operator's CLI pin on every unrelated redeploy — and the troubleshooting guide
   *  prescribes that CLI pin as the fix for a wrong model.
   *
   *  Worst case was this very upgrade: a deployer who pinned `us.` per repo would
   *  lose the pin AND get the default flipped to `global.` in one deploy.
   *
   *  The underlying gap is real but wider than one column — 12 other SET-only fields
   *  survive being dropped too — and fixing it needs an explicit "clear" signal
   *  (`modelId: null`) plus a warning, not a silent delete. Tracked separately.
   */
  private clearedOverrideFields(_props: BlueprintProps): string[] {
    return [];
  }

  private buildRemoveClause(props?: BlueprintProps): string {
    const fields = [...this.emptyAssetFields(), ...(props ? this.clearedOverrideFields(props) : [])];
    return fields.length > 0 ? ` REMOVE ${fields.map(f => `#${f}`).join(', ')}` : '';
  }

  private buildRemoveNames(props?: BlueprintProps): Record<string, string> {
    const names: Record<string, string> = {};
    const fields = [...this.emptyAssetFields(), ...(props ? this.clearedOverrideFields(props) : [])];
    for (const f of fields) names[`#${f}`] = f;
    return names;
  }
}

/**
 * Validates that the repo string matches the "owner/repo" format.
 */
class RepoFormatValidation implements IValidation {
  constructor(private readonly repo: string) {}

  public validate(): string[] {
    if (!REPO_PATTERN.test(this.repo)) {
      return [`Invalid repo format: '${this.repo}'. Expected 'owner/repo'.`];
    }
    return [];
  }
}

/**
 * Validates that all egress allowlist domains match the expected format.
 */
class DomainFormatValidation implements IValidation {
  constructor(private readonly domains: readonly string[]) {}

  public validate(): string[] {
    const errors: string[] = [];
    for (const domain of this.domains) {
      if (!DOMAIN_PATTERN.test(domain)) {
        errors.push(`Invalid egress allowlist domain: '${domain}'. Expected a lowercase domain (e.g. 'example.com' or '*.example.com').`);
      }
    }
    return errors;
  }
}

/**
 * Cedar HITL — validates the per-blueprint approval-gate cap is an integer
 * inside ``[1, 500]`` (design decision #13). Out-of-bounds values fail at
 * synth so an invalid blueprint cannot deploy and silently drift agent
 * behavior. ``undefined`` is allowed — the submit path falls back to the
 * platform default.
 */
class ApprovalGateCapValidation implements IValidation {
  constructor(private readonly cap: number | undefined) {}

  public validate(): string[] {
    if (this.cap === undefined) {
      return [];
    }
    if (!Number.isInteger(this.cap)) {
      return [`Invalid security.approvalGateCap: ${this.cap}. Must be an integer.`];
    }
    if (this.cap < APPROVAL_GATE_CAP_MIN || this.cap > APPROVAL_GATE_CAP_MAX) {
      return [
        `Invalid security.approvalGateCap: ${this.cap}. ` +
        `Must be between ${APPROVAL_GATE_CAP_MIN} and ${APPROVAL_GATE_CAP_MAX}.`,
      ];
    }
    return [];
  }
}

/**
 * #748 — validates the per-repo cost budget is a finite number inside
 * ``[MAX_BUDGET_USD_MIN, MAX_BUDGET_USD_MAX]``. Bounds come from
 * ``contracts/constants.json``, the SAME source the task-submit path validates
 * a per-task ``max_budget_usd`` against — so a blueprint cannot persist a
 * per-repo default that a per-task override of the same value would reject.
 * Out-of-range fails at synth rather than deploying a budget the agent would
 * then act on. ``undefined`` is allowed: there is no platform default, and
 * unset deliberately means unlimited.
 *
 * Fractional values ARE valid (unlike ``approvalGateCap``) — a budget is
 * dollars-and-cents, and the minimum is one cent.
 */
class MaxBudgetUsdValidation implements IValidation {
  constructor(private readonly budget: number | undefined) {}

  public validate(): string[] {
    if (this.budget === undefined) {
      return [];
    }
    if (!Number.isFinite(this.budget)) {
      return [`Invalid agent.maxBudgetUsd: ${this.budget}. Must be a finite number.`];
    }
    if (this.budget < MAX_BUDGET_USD_MIN || this.budget > MAX_BUDGET_USD_MAX) {
      return [
        `Invalid agent.maxBudgetUsd: ${this.budget}. ` +
        `Must be between ${MAX_BUDGET_USD_MIN} and ${MAX_BUDGET_USD_MAX}.`,
      ];
    }
    return [];
  }
}

/**
 * Registry (#246) — validates each ``registry://`` asset ref against the strict
 * grammar at synth, so a floating or malformed pin cannot deploy and then fail
 * every task at resolve time. Uses the same ``parseRef`` the resolver enforces.
 *
 * Also enforces that the ref's kind matches the field it was pinned under
 * (``expectedKind``). Each typed Blueprint field stores into a distinct DDB
 * column, and the orchestrator dispatches by the ref's embedded kind — so a
 * ``skill`` ref placed under ``assets.mcpServers`` would otherwise deploy and
 * then silently activate skill behavior from an "MCP" column. Reject the
 * mismatch at synth instead.
 */
class RegistryRefValidation implements IValidation {
  constructor(
    private readonly field: string,
    private readonly refs: readonly string[],
    private readonly expectedKind: string,
  ) {}

  public validate(): string[] {
    const errors: string[] = [];
    for (const ref of this.refs) {
      const result = parseRef(ref);
      if (!result.ok) {
        errors.push(`Invalid ${this.field} ref '${ref}': ${result.reason} — ${result.message}`);
        continue;
      }
      if (result.ref.kind !== this.expectedKind) {
        errors.push(
          `Wrong kind for ${this.field} ref '${ref}': expected a '${this.expectedKind}' ref `
          + `but got '${result.ref.kind}'.`,
        );
      }
    }
    return errors;
  }
}
