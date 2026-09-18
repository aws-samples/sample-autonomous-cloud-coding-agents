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

import * as bedrock from '@aws-cdk/aws-bedrock-alpha';
import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import agentTaskWriteAttributes from './agent-task-write-attributes.json';
import constants from '../../../contracts/constants.json';

/**
 * Task reporting may update only the attributes written by task_state.py.
 * Keep whole-row replacement/deletion and coordinator metadata out of this
 * grant. DynamoDB evaluates each transaction item using its item action, so
 * approval UpdateItem operations receive the same restriction.
 *
 * This protects writes, not reads: agents may read their complete task record.
 * The JSON list is also checked against actual Python writer requests in tests.
 * Used for both scoped sessions and the legacy ECS direct-grant fallback.
 */
export function grantAgentTaskTableAccess(
  table: dynamodb.ITable,
  grantee: iam.IGrantable,
  taskScoped: boolean,
): void {
  const leadingKeys = taskScoped
    ? { 'dynamodb:LeadingKeys': ['${aws:PrincipalTag/task_id}'] }
    : {};
  const readLeadingKeys = taskScoped
    ? {
      'dynamodb:LeadingKeys': [
        '${aws:PrincipalTag/task_id}', `${constants.microvm_continuation.lease_key_prefix}\${aws:PrincipalTag/task_id}`,
      ],
    }
    : {};
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query', 'dynamodb:ConditionCheckItem'],
    resources: [table.tableArn],
    ...(taskScoped ? {
      conditions: {
        'ForAllValues:StringEquals': readLeadingKeys,
        'Null': { 'dynamodb:LeadingKeys': 'false' },
      },
    } : {}),
  }));
  grantee.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
    actions: ['dynamodb:UpdateItem'],
    resources: [table.tableArn],
    conditions: {
      'ForAllValues:StringEquals': {
        ...leadingKeys,
        'dynamodb:Attributes': agentTaskWriteAttributes,
      },
      // ForAllValues alone also matches an absent context key. Require the
      // attribute list (and session key when scoped) to be present.
      'Null': {
        'dynamodb:Attributes': 'false',
        ...(taskScoped ? { 'dynamodb:LeadingKeys': 'false' } : {}),
      },
    },
  }));
}

/** S3 key prefixes the agent writes/reads, scoped per tenant. */
const TRACE_KEY_PREFIX = 'traces';
const ATTACHMENT_KEY_PREFIX = 'attachments';
/** Repo-less deliverable artifacts (#248 Phase 3), scoped per task_id. */
const ARTIFACT_KEY_PREFIX = 'artifacts';

/**
 * Properties for {@link AgentSessionRole}.
 */
export interface AgentSessionRoleProps {
  /**
   * Compute roles (AgentCore Runtime, ECS Fargate or Lambda MicroVM) permitted
   * to assume this SessionRole and pass session tags. These principals mint
   * scoped credentials. The agent code sources the
   * `{user_id, repo, task_id}` tag values from the resolved TaskConfig.
   */
  readonly assumingRoles: iam.IRole[];

  /**
   * The main task table: own-task reads and attribute-scoped reporting updates.
   * Task creation/deletion, owner identity, compute handles, start receipts and
   * capacity reservations belong to the coordinator.
   */
  readonly taskTable: dynamodb.ITable;

  /**
   * Supporting task-scoped tables (events, approvals, nudges), all partitioned
   * by `task_id`. Do not include taskTable here: that would bypass its write
   * restriction. The SessionRole receives item-level access constrained by a
   * `dynamodb:LeadingKeys` condition on `aws:PrincipalTag/task_id`, so a
   * session can only touch its own task's rows. Order is irrelevant.
   */
  readonly taskScopedTables: dynamodb.ITable[];

  /**
   * Trace-artifacts bucket. The agent writes `traces/<user_id>/<task_id>...`;
   * `s3:PutObject` is scoped to the `traces/${aws:PrincipalTag/user_id}/`
   * prefix.
   */
  readonly traceArtifactsBucket: s3.IBucket;

  /**
   * Attachments bucket. The agent reads `attachments/<user_id>/<task_id>/...`;
   * `s3:GetObject*` is scoped to the `attachments/${aws:PrincipalTag/user_id}/`
   * prefix.
   */
  readonly attachmentsBucket: s3.IBucket;

  /**
   * Bedrock models / cross-region inference profiles the agent may invoke
   * (#215, cost attribution). When provided, each is `grantInvoke`-ed to the
   * SessionRole — the **same** grant the compute role receives, so the
   * permission set (including the all-regions foundation-model ARNs a
   * cross-region profile fans out to) stays in lockstep and a cross-region
   * route can never AccessDenied. Model inference run by the Claude Code
   * subprocess is then attributed per `{user_id, repo}` in CUR 2.0 / Cost
   * Explorer via the session tags this role already carries.
   *
   * The compute role keeps its own Bedrock grant. On AgentCore/ECS, the export
   * helper can fall back to compute-role credentials if attribution fails.
   * MicroVM workers instead use the retained task-scoped credential provider;
   * failed renewal blocks wake rather than falling back to ambient credentials.
   * Omit (e.g. isolated construct tests) to skip the Bedrock grant.
   */
  readonly invokableModels?: bedrock.IBedrockInvokable[];
}

/**
 * Per-task SessionRole assumed by the agent for **tenant-data** access.
 *
 * Each task's agent calls `sts:AssumeRole` against this role with session tags
 * `{user_id, repo, task_id}` and uses the short-lived credentials for its
 * DynamoDB and S3 access. The role's policies self-constrain via
 * `aws:PrincipalTag/*` conditions:
 *
 * - DynamoDB item access on the four `task_id`-partitioned tables is gated by
 *   a `dynamodb:LeadingKeys` condition on `aws:PrincipalTag/task_id` (Scan is
 *   deliberately not granted — it ignores leading-keys).
 * - S3 trace writes and attachment reads are scoped to the
 *   `<prefix>/${aws:PrincipalTag/user_id}/` object prefix.
 *
 * Existing session credentials are limited to their tagged task. Compute roles
 * choose these tags when assuming this role; the trust policy does not bind
 * those choices to a particular task. This is not an isolation claim for a
 * compromised worker that can obtain ambient compute credentials.
 * TaskTable writes additionally exclude coordinator-owned attributes and
 * whole-row replacement/deletion. All three compute backends share this role.
 *
 * CloudWatch Logs remains on the compute role (shared access). The
 * compute role *also* keeps `InvokeModel`; this role adds a parallel, session-
 * tagged Bedrock grant (#215) used by the Claude Code subprocess for cost
 * attribution. AgentCore/ECS use `awsCredentialExport` with expiry and an ambient
 * fallback for attribution failures. MicroVM uses the parent's retained scoped
 * provider with synchronous renewal; the export helper returns no credentials.
 * The background export refresh is not a MicroVM wake barrier.
 */
export class AgentSessionRole extends Construct {
  /** Actions sufficient for the agent's DynamoDB access. Excludes Scan. */
  private static readonly DDB_ITEM_ACTIONS = [
    'dynamodb:GetItem',
    'dynamodb:BatchGetItem',
    'dynamodb:Query',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'dynamodb:DeleteItem',
    'dynamodb:BatchWriteItem',
    'dynamodb:ConditionCheckItem',
  ];

  /** The SessionRole. Assumed by the agent at task startup. */
  public readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: AgentSessionRoleProps) {
    super(scope, id);

    if (props.assumingRoles.length === 0) {
      // A SessionRole no principal can assume is dead weight and would
      // synthesize an empty/invalid trust policy. Fail at synth instead.
      throw new Error(
        'AgentSessionRole requires at least one assuming role (the compute role[s] that mint scoped credentials)',
      );
    }
    if (props.taskScopedTables.some((table) => table.tableArn === props.taskTable.tableArn)) {
      throw new Error('taskTable must not appear in taskScopedTables; it requires restricted writes');
    }

    const [firstAssumingRole] = props.assumingRoles;

    // CDK requires assumedBy; additional principals are admitted via
    // admitComputeRole so trust + grant always wire together.
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ArnPrincipal(firstAssumingRole.roleArn),
      description:
        'Per-task scoped credentials for ABCA agent tenant-data access '
        + '(DynamoDB task rows + S3 trace/attachment objects), constrained by '
        + 'session tags {user_id, repo, task_id}.',
      // Role chaining (agent assumes this from the compute role) hard-caps the
      // session at 1 hour regardless of this value; set it explicitly so the
      // intent is documented and synth-visible.
      maxSessionDuration: Duration.hours(1),
    });

    grantAgentTaskTableAccess(props.taskTable, this.role, true);

    // --- Supporting tables: item access gated by task_id leading-key ---
    // One statement per table keeps the resource ARNs explicit. The condition
    // requires the request's partition key (task_id) to equal the session's
    // task_id tag. ForAllValues is required by DynamoDB for LeadingKeys.
    for (const table of props.taskScopedTables) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          actions: AgentSessionRole.DDB_ITEM_ACTIONS,
          resources: [table.tableArn],
          conditions: {
            'ForAllValues:StringEquals': {
              'dynamodb:LeadingKeys': ['${aws:PrincipalTag/task_id}'],
            },
            'Null': { 'dynamodb:LeadingKeys': 'false' },
          },
        }),
      );
    }

    // --- S3 trace writes: scoped to traces/<user_id>/ ---
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [
          props.traceArtifactsBucket.arnForObjects(
            `${TRACE_KEY_PREFIX}/\${aws:PrincipalTag/user_id}/*`,
          ),
        ],
      }),
    );

    // --- S3 attachment reads: scoped to attachments/<user_id>/ ---
    // grantRead-equivalent action set, including version reads (the agent uses
    // GetObjectVersion); scoped by the per-user prefix.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:GetObjectVersion'],
        resources: [
          props.attachmentsBucket.arnForObjects(
            `${ATTACHMENT_KEY_PREFIX}/\${aws:PrincipalTag/user_id}/*`,
          ),
        ],
      }),
    );

    // --- S3 artifact writes: scoped to artifacts/<task_id>/ (#248 Phase 3) ---
    // A repo-less workflow's deliver_artifact step uploads its product here. The
    // key is task_id-scoped (per ADR-014 addendum) — same PrincipalTag the
    // DynamoDB LeadingKeys condition uses — sharing the trace-artifacts bucket.
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [
          props.traceArtifactsBucket.arnForObjects(
            `${ARTIFACT_KEY_PREFIX}/\${aws:PrincipalTag/task_id}/*`,
          ),
        ],
      }),
    );

    // --- Bedrock model invocation: tagged for cost attribution (#215) ---
    // Reuse grantInvoke so this role's Bedrock permissions exactly mirror the
    // compute role's (cross-region profiles fan out to the foundation model in
    // every routed region — replicating that by hand would risk an AccessDenied
    // on a cross-region route). Claude Code uses this role through the export
    // helper or MicroVM's scoped provider, so InvokeModel rides the session's
    // {user_id, repo, task_id} tags, surfacing per-user/repo Bedrock spend in
    // CUR 2.0 / Cost Explorer. No PrincipalTag condition: the tags are for
    // billing attribution, not access scoping, so a condition would add no
    // isolation and only risk breakage.
    for (const invokable of props.invokableModels ?? []) {
      invokable.grantInvoke(this.role);
    }

    // The object-level prefix conditions above already constrain access to the
    // session's own tenant prefix; the remaining wildcard is the per-object
    // suffix (task_id/attachment_id/filename), which is the intended scope.
    NagSuppressions.addResourceSuppressions(
      this.role,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Resource wildcards are the per-object suffix under a tenant-scoped '
            + 'prefix (traces/${aws:PrincipalTag/user_id}/*, '
            + 'attachments/${aws:PrincipalTag/user_id}/*, '
            + 'continuations/${aws:PrincipalTag/task_id}/*, '
            + 'artifacts/${aws:PrincipalTag/task_id}/*) and the DynamoDB item '
            + 'set gated by a dynamodb:LeadingKeys = ${aws:PrincipalTag/task_id} '
            + 'condition — narrower than the compute role this replaces. Bedrock '
            + 'InvokeModel resources are the explicit model + inference-profile '
            + 'ARNs from grantInvoke (cross-region profiles fan out to per-region '
            + 'foundation-model ARNs), matching the compute role grant (#215).',
        },
      ],
      true,
    );

    for (const computeRole of props.assumingRoles) {
      this.admitComputeRole(computeRole);
    }
  }

  /**
   * Admit a compute role to assume this SessionRole with session tags. Wires
   * both halves AssumeRole requires: trust on this SessionRole and
   * `sts:AssumeRole`/`sts:TagSession` on the compute role's identity policy.
   */
  public admitComputeRole(computeRole: iam.IRole): void {
    this.addTrustForComputeRole(computeRole);
    this.grantAssumeToComputeRole(computeRole);
  }

  /** Add bundled AssumeRole + TagSession trust for one compute principal. */
  private addTrustForComputeRole(computeRole: iam.IRole): void {
    this.role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        principals: [new iam.ArnPrincipal(computeRole.roleArn)],
      }),
    );
  }

  /**
   * Grant a compute role permission to assume this SessionRole and pass
   * session tags. Adds `sts:AssumeRole` + `sts:TagSession` to the grantee's
   * policy (a separate IAM::Policy resource, so no dependency cycle with this
   * role's trust policy).
   */
  private grantAssumeToComputeRole(computeRole: iam.IRole): void {
    computeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.role.roleArn],
      }),
    );
  }
}
