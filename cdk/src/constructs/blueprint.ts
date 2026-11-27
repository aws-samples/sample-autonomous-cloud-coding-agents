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

import { Duration, Token } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { Construct, IValidation } from 'constructs';
// Cross-language constants (S9 — see ``contracts/constants.md``). Import
// the JSON directly rather than re-using ``handlers/shared/types.ts`` so
// the construct layer stays decoupled from runtime-side types.
import sharedConstants from '../../../contracts/constants.json';
import { parseRef } from '../handlers/shared/registry/ref';
import {
  BEDROCK_GEO_REGION_CONTEXT_KEY,
  BEDROCK_MODELS_CONTEXT_KEY,
  geoPrefixOf,
  resolveBedrockGeoRegion,
  resolveBedrockModelIds,
} from './bedrock-models';

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
     * Model override, as a Bedrock inference-profile ID: ``<geo>.<model>``, for
     * example ``global.anthropic.claude-opus-5-5``.
     *
     * Checked at synth. Only that form is accepted, with the deployment's
     * geography (``bedrockGeoRegion`` context) and a model the deployment grants
     * (``bedrockModels`` context). A bare foundation-model ID, an ARN, another
     * geography's prefix or a model outside the grant list fails the synth.
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
     * Token budget for the memory context (repository knowledge and past task
     * episodes) that context hydration loads into the agent's system prompt
     * for tasks against this repo (#447). Hydration retrieves at most five
     * knowledge records and three episodes; the budget decides how many of
     * them are kept. Knowledge is kept first, then episodes, and the first
     * record of a kind that does not fit ends that list. A larger budget never
     * loads more than those eight records.
     *
     * Must be a positive integer, at most ``Number.MAX_SAFE_INTEGER``; any
     * other value fails at synth. A repo whose RepoTable row holds no budget
     * gets the platform default of 2000 tokens. There is no per-task override.
     */
    readonly memoryTokenBudget?: number;

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
   *
   * A list that is left out keeps the value the repository's record holds; a
   * list declared as ``[]`` is removed from the record.
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
 * Create and Update: one UpdateItem that sets status='active', updated_at, onboarded_at
 * (only if the row has none) and the fields the Blueprint declares, removes ttl and each
 * asset list the Blueprint declares as empty, and leaves every other attribute as it is,
 * because `bgagent repo onboard` writes the same row (ADR-017).
 * Delete: UpdateItem to set status='removed' and TTL for eventual cleanup.
 *
 * NOTE: Timestamps (onboarded_at, updated_at) are captured at CDK synth time,
 * not CloudFormation deploy time. This is an inherent limitation of AwsCustomResource
 * where parameters are baked into the template. For precise deploy-time timestamps,
 * a full custom resource Lambda would be needed.
 */
export class Blueprint extends Construct {
  constructor(scope: Construct, id: string, props: BlueprintProps) {
    super(scope, id);

    const egressAllowlist = [...(props.networking?.egressAllowlist ?? [])];
    const cedarPolicies = [...(props.security?.cedarPolicies ?? [])];
    const approvalGateCap = props.security?.approvalGateCap;
    const { maxBudgetUsd, memoryTokenBudget } = props.agent ?? {};
    const assets = props.assets ?? {};
    const mcpServerRefs = [...(assets.mcpServers ?? [])];
    const cedarPolicyModuleRefs = [...(assets.cedarPolicyModules ?? [])];
    const skillRefs = [...(assets.skills ?? [])];

    // Validate repo format at construct time
    this.node.addValidation(new RepoFormatValidation(props.repo));
    this.node.addValidation(new DomainFormatValidation(egressAllowlist));
    this.node.addValidation(new ApprovalGateCapValidation(approvalGateCap));
    this.node.addValidation(new MaxBudgetUsdValidation(maxBudgetUsd));
    this.node.addValidation(new MemoryTokenBudgetValidation(memoryTokenBudget));
    this.node.addValidation(new RegistryRefValidation('assets.mcpServers', mcpServerRefs, 'mcp_server'));
    this.node.addValidation(new RegistryRefValidation('assets.cedarPolicyModules', cedarPolicyModuleRefs, 'cedar_policy_module'));
    this.node.addValidation(new RegistryRefValidation('assets.skills', skillRefs, 'skill'));

    const now = new Date().toISOString();

    // What the Blueprint declares, by RepoTable column.
    const overrides: Record<string, unknown> = {};

    if (props.compute?.type) {
      overrides.compute_type = { S: props.compute.type };
    }
    if (props.compute?.runtimeArn) {
      overrides.runtime_arn = { S: props.compute.runtimeArn };
    }
    if (props.agent?.modelId) {
      overrides.model_id = { S: props.agent.modelId };
      // Registered next to the write, so that a model is checked exactly when it is
      // written and a Blueprint that pins none does not read the model context.
      this.node.addValidation(new ModelIdValidation(
        props.agent.modelId,
        resolveBedrockGeoRegion(this.node),
        resolveBedrockModelIds(this.node),
      ));
    }
    if (props.agent?.maxTurns !== undefined) {
      overrides.max_turns = { N: String(props.agent.maxTurns) };
    }
    if (maxBudgetUsd !== undefined) {
      overrides.max_budget_usd = { N: String(maxBudgetUsd) };
    }
    if (memoryTokenBudget !== undefined) {
      overrides.memory_token_budget = { N: String(memoryTokenBudget) };
    }
    if (props.agent?.systemPromptOverrides) {
      overrides.system_prompt_overrides = { S: props.agent.systemPromptOverrides };
    }
    if (props.credentials?.githubTokenSecretArn) {
      overrides.github_token_secret_arn = { S: props.credentials.githubTokenSecretArn };
    }
    if (props.pipeline?.pollIntervalMs !== undefined) {
      overrides.poll_interval_ms = { N: String(props.pipeline.pollIntervalMs) };
    }
    if (props.pipeline?.buildCommand) {
      overrides.build_command = { S: props.pipeline.buildCommand };
    }
    if (props.pipeline?.lintCommand) {
      overrides.lint_command = { S: props.pipeline.lintCommand };
    }
    if (egressAllowlist.length > 0) {
      overrides.egress_allowlist = { L: egressAllowlist.map(d => ({ S: d })) };
    }
    if (cedarPolicies.length > 0) {
      overrides.cedar_policies = { L: cedarPolicies.map(p => ({ S: p })) };
    }
    if (approvalGateCap !== undefined) {
      overrides.approval_gate_cap = { N: String(approvalGateCap) };
    }
    if (mcpServerRefs.length > 0) {
      overrides.mcp_servers = { L: mcpServerRefs.map(r => ({ S: r })) };
    }
    if (cedarPolicyModuleRefs.length > 0) {
      overrides.cedar_policy_modules = { L: cedarPolicyModuleRefs.map(r => ({ S: r })) };
    }
    if (skillRefs.length > 0) {
      overrides.skills = { L: skillRefs.map(r => ({ S: r })) };
    }

    const declared = Object.keys(overrides);
    // ttl, so that a row an offboard left does not expire; an asset list declared as [], so that its pins are detached.
    const removed = ['ttl', ...Object.entries({
      mcp_servers: assets.mcpServers,
      cedar_policy_modules: assets.cedarPolicyModules,
      skills: assets.skills,
    }).filter(([, refs]) => refs?.length === 0).map(([column]) => column)];

    new cr.AwsCustomResource(this, 'RepoConfigCR', {
      timeout: Duration.minutes(REPO_CONFIG_CR_TIMEOUT_MINUTES),
      // No onCreate: AwsCustomResource then makes this call for the create event too.
      onUpdate: {
        service: 'DynamoDB',
        action: 'updateItem',
        parameters: {
          TableName: props.repoTable.tableName,
          Key: { repo: { S: props.repo } },
          UpdateExpression: 'SET #status = :active, #updated_at = :now, #onboarded_at = if_not_exists(#onboarded_at, :now)'
            + declared.map(column => `, #${column} = :${column}`).join('')
            + ` REMOVE ${removed.map(column => `#${column}`).join(', ')}`,
          ExpressionAttributeNames: Object.fromEntries(
            ['status', 'updated_at', 'onboarded_at', ...declared, ...removed].map(column => [`#${column}`, column]),
          ),
          ExpressionAttributeValues: {
            ':active': { S: 'active' },
            ':now': { S: now },
            ...Object.fromEntries(declared.map(column => [`:${column}`, overrides[column]])),
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
          actions: ['dynamodb:UpdateItem'],
          resources: [props.repoTable.tableArn],
        }),
      ]),
    });
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
 * The upper bound is ``Number.MAX_SAFE_INTEGER`` because the orchestrator's
 * DynamoDB client returns a larger number as a BigInt (#447).
 */
class MemoryTokenBudgetValidation implements IValidation {
  constructor(private readonly budget: number | undefined) {}

  public validate(): string[] {
    if (this.budget === undefined) {
      return [];
    }
    if (!Number.isSafeInteger(this.budget) || this.budget <= 0) {
      return [`Invalid agent.memoryTokenBudget: ${this.budget}. Must be an integer between 1 and ${Number.MAX_SAFE_INTEGER}.`];
    }
    return [];
  }
}

/**
 * ``assertModelIdUsable`` in ``cli/src/model-id.ts`` guards the same ``model_id``
 * column (ADR-017). A value that only one of the two rejects still reaches a task.
 */
class ModelIdValidation implements IValidation {
  constructor(
    private readonly modelId: string,
    private readonly geoRegion: string,
    private readonly grantedModelIds: readonly string[],
  ) {}

  public validate(): string[] {
    const { modelId, geoRegion, grantedModelIds } = this;
    const invalid = (reason: string): string[] => [`Invalid agent.modelId: '${modelId}'. ${reason}`];

    if (modelId !== modelId.trim()) {
      return invalid('Remove the surrounding whitespace: the value is written to the RepoTable as given.');
    }
    // A token and an ARN have no geography prefix either. Left to the rule after
    // these two, they would be reported as a bare ID, with a suggestion built from them.
    if (Token.isUnresolved(modelId)) {
      return invalid('It contains an unresolved token: agent.modelId must be a literal, so that it can be checked at synth.');
    }
    if (modelId.startsWith('arn:')) {
      return invalid(
        `It is an ARN. Use the inference-profile ID '${geoRegion}.<model-id>' `
        + '(for a system-defined profile, the last path segment of its ARN).',
      );
    }
    const geo = geoPrefixOf(modelId);
    if (geo === undefined) {
      // With the prefix added, a value that is not a granted model (an alias, an ungranted
      // ID) still fails the next synth, so no value to use is built from it.
      if (!grantedModelIds.includes(modelId)) {
        return invalid(
          `It has no geography prefix. Use '${geoRegion}.<model-id>' with a model this deployment grants `
          + `(${grantedModelIds.join(', ')}).`,
        );
      }
      return invalid(
        'It has no geography prefix, and a bare foundation-model ID cannot be invoked on demand. '
        + `Use the inference-profile ID '${geoRegion}.${modelId}'.`,
      );
    }
    const bare = modelId.slice(geo.length + 1);
    if (!bare) {
      return invalid(`It is a geography prefix with no model after it. Use '${geoRegion}.<model-id>'.`);
    }
    const secondGeo = geoPrefixOf(bare);
    if (secondGeo !== undefined) {
      const rest = bare.slice(secondGeo.length + 1);
      return invalid(
        `It carries two geography prefixes ('${geo}.' then '${secondGeo}.'). `
        + `Use one: '${geoRegion}.${grantedModelIds.includes(rest) ? rest : '<model-id>'}'.`,
      );
    }
    if (!grantedModelIds.includes(bare)) {
      return invalid(
        `'${bare}' is not a model this deployment grants (${grantedModelIds.join(', ')}). `
        + `Add it to the '${BEDROCK_MODELS_CONTEXT_KEY}' context, or pin a granted model.`,
      );
    }
    if (geo !== geoRegion) {
      return invalid(
        `It is a '${geo}' inference profile, but this deployment grants '${geoRegion}' profiles `
        + `('${BEDROCK_GEO_REGION_CONTEXT_KEY}' context). Use '${geoRegion}.${bare}'.`,
      );
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
