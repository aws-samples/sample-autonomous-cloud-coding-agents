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

import { Duration } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

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
   * Compute roles (AgentCore Runtime ExecutionRole and/or ECS Fargate task
   * role) permitted to assume this SessionRole and pass session tags. These
   * are the only principals trusted to mint scoped credentials, so they bound
   * the trust surface. Both run the same trusted agent code, which sources the
   * `{user_id, repo, task_id}` tag values from the resolved TaskConfig.
   */
  readonly assumingRoles: iam.IRole[];

  /**
   * The four task-scoped DynamoDB tables, all partitioned by `task_id`. The
   * SessionRole receives item-level access constrained by a
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
 * The result: a compromised agent session can reach only its own task's data,
 * not other tenants' — enforced at the IAM layer rather than in application
 * code. Backend-agnostic: the same role serves agents booted under either the
 * AgentCore Runtime execution role or the ECS Fargate task role.
 *
 * Bedrock model invocation and CloudWatch Logs intentionally remain on the
 * compute role (shared, non-tenant access; and keeping `InvokeModel` off the
 * 1-hour-capped chained session avoids breaking long tasks).
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

    const principals = props.assumingRoles.map(
      (r) => new iam.ArnPrincipal(r.roleArn),
    );

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.CompositePrincipal(...principals),
      description:
        'Per-task scoped credentials for ABCA agent tenant-data access '
        + '(DynamoDB task rows + S3 trace/attachment objects), constrained by '
        + 'session tags {user_id, repo, task_id}.',
      // Role chaining (agent assumes this from the compute role) hard-caps the
      // session at 1 hour regardless of this value; set it explicitly so the
      // intent is documented and synth-visible.
      maxSessionDuration: Duration.hours(1),
    });

    // The agent passes session tags on AssumeRole, which requires the trust
    // policy to also allow sts:TagSession (CDK's assumedBy only adds
    // sts:AssumeRole). Same principals.
    this.role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:TagSession'],
        principals,
      }),
    );

    // --- DynamoDB: item access gated by task_id leading-key ---
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
            + 'artifacts/${aws:PrincipalTag/task_id}/*) and the DynamoDB item '
            + 'set gated by a dynamodb:LeadingKeys = ${aws:PrincipalTag/task_id} '
            + 'condition — narrower than the compute role this replaces.',
        },
      ],
      true,
    );
  }

  /**
   * Admit an additional compute role to the trust policy (e.g. the ECS Fargate
   * task role when that backend is enabled). Adds `sts:AssumeRole` +
   * `sts:TagSession` for the role to this SessionRole's trust policy.
   */
  public addAssumingRole(computeRole: iam.IRole): void {
    const principal = new iam.ArnPrincipal(computeRole.roleArn);
    this.role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        principals: [principal],
      }),
    );
  }

  /**
   * Grant a compute role permission to assume this SessionRole and pass
   * session tags. Adds `sts:AssumeRole` + `sts:TagSession` to the grantee's
   * policy (a separate IAM::Policy resource, so no dependency cycle with this
   * role's trust policy).
   */
  public grantAssumeToComputeRole(computeRole: iam.IRole): void {
    computeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.role.roleArn],
      }),
    );
  }
}
