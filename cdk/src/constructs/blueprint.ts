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
}

/**
 * CDK construct that registers a repository with the platform by writing
 * a RepoConfig record to the shared RepoTable via a custom resource.
 *
 * Create/Update: PutItem with status='active' and all config fields.
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

  constructor(scope: Construct, id: string, props: BlueprintProps) {
    super(scope, id);

    this.egressAllowlist = [...(props.networking?.egressAllowlist ?? [])];
    this.cedarPolicies = [...(props.security?.cedarPolicies ?? [])];
    this.approvalGateCap = props.security?.approvalGateCap;

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
    if (props.agent?.systemPromptOverrides) {
      item.system_prompt_overrides = { S: props.agent.systemPromptOverrides };
    }
    if (props.credentials?.githubTokenSecretArn) {
      item.github_token_secret_arn = { S: props.credentials.githubTokenSecretArn };
    }
    if (props.pipeline?.pollIntervalMs !== undefined) {
      item.poll_interval_ms = { N: String(props.pipeline.pollIntervalMs) };
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

    new cr.AwsCustomResource(this, 'RepoConfigCR', {
      timeout: Duration.minutes(5),
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
          UpdateExpression: `SET #status = :active, #updated = :now${this.buildUpdateFields(props)}`,
          ExpressionAttributeNames: {
            '#status': 'status',
            '#updated': 'updated_at',
            ...this.buildExpressionNames(props),
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
            ':ttl': { N: String(Math.floor(Date.now() / 1000) + 30 * 86400) },
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
    if (props.agent?.systemPromptOverrides) fields.push(', #system_prompt_overrides = :system_prompt_overrides');
    if (props.credentials?.githubTokenSecretArn) fields.push(', #github_token_secret_arn = :github_token_secret_arn');
    if (props.pipeline?.pollIntervalMs !== undefined) fields.push(', #poll_interval_ms = :poll_interval_ms');
    if (this.egressAllowlist.length > 0) fields.push(', #egress_allowlist = :egress_allowlist');
    if (this.cedarPolicies.length > 0) fields.push(', #cedar_policies = :cedar_policies');
    if (this.approvalGateCap !== undefined) fields.push(', #approval_gate_cap = :approval_gate_cap');
    return fields.join('');
  }

  private buildExpressionNames(props: BlueprintProps): Record<string, string> {
    const names: Record<string, string> = {};
    if (props.compute?.type) names['#compute_type'] = 'compute_type';
    if (props.compute?.runtimeArn) names['#runtime_arn'] = 'runtime_arn';
    if (props.agent?.modelId) names['#model_id'] = 'model_id';
    if (props.agent?.maxTurns !== undefined) names['#max_turns'] = 'max_turns';
    if (props.agent?.systemPromptOverrides) names['#system_prompt_overrides'] = 'system_prompt_overrides';
    if (props.credentials?.githubTokenSecretArn) names['#github_token_secret_arn'] = 'github_token_secret_arn';
    if (props.pipeline?.pollIntervalMs !== undefined) names['#poll_interval_ms'] = 'poll_interval_ms';
    if (this.egressAllowlist.length > 0) names['#egress_allowlist'] = 'egress_allowlist';
    if (this.cedarPolicies.length > 0) names['#cedar_policies'] = 'cedar_policies';
    if (this.approvalGateCap !== undefined) names['#approval_gate_cap'] = 'approval_gate_cap';
    return names;
  }

  private buildExpressionValues(props: BlueprintProps): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    if (props.compute?.type) values[':compute_type'] = { S: props.compute.type };
    if (props.compute?.runtimeArn) values[':runtime_arn'] = { S: props.compute.runtimeArn };
    if (props.agent?.modelId) values[':model_id'] = { S: props.agent.modelId };
    if (props.agent?.maxTurns !== undefined) values[':max_turns'] = { N: String(props.agent.maxTurns) };
    if (props.agent?.systemPromptOverrides) values[':system_prompt_overrides'] = { S: props.agent.systemPromptOverrides };
    if (props.credentials?.githubTokenSecretArn) values[':github_token_secret_arn'] = { S: props.credentials.githubTokenSecretArn };
    if (props.pipeline?.pollIntervalMs !== undefined) values[':poll_interval_ms'] = { N: String(props.pipeline.pollIntervalMs) };
    if (this.egressAllowlist.length > 0) values[':egress_allowlist'] = { L: this.egressAllowlist.map(d => ({ S: d })) };
    if (this.cedarPolicies.length > 0) values[':cedar_policies'] = { L: this.cedarPolicies.map(p => ({ S: p })) };
    if (this.approvalGateCap !== undefined) values[':approval_gate_cap'] = { N: String(this.approvalGateCap) };
    return values;
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
