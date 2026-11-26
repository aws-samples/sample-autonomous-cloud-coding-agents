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
import { AspectPriority, Aspects, Duration, Lazy } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct, IConstruct } from 'constructs';

const TRACE_KEY_PREFIX = 'traces';
const ATTACHMENT_KEY_PREFIX = 'attachments';
const ARTIFACT_KEY_PREFIX = 'artifacts';

export interface AgentSessionRoleProps {
  /**
   * Compute roles (AgentCore Runtime ExecutionRole and/or ECS Fargate task
   * role) permitted to assume this SessionRole and pass session tags.
   */
  readonly assumingRoles?: iam.IRole[];
  /** Admit deployed backends with admitComputeRole after constructing this role. */
  readonly deferComputeRoleBinding?: boolean;

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

  /**
   * Bedrock models / cross-region inference profiles the agent may invoke
   * (#215, cost attribution). When provided, each is `grantInvoke`-ed to the
   * SessionRole — the **same** grant the compute role receives.
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
 */
export class AgentSessionRole extends Construct {
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

  public readonly role: iam.Role;
  private readonly admittedRoles = new Set<iam.IRole>();

  constructor(scope: Construct, id: string, props: AgentSessionRoleProps) {
    super(scope, id);

    if (!props.assumingRoles?.length && !props.deferComputeRoleBinding) {
      throw new Error(
        'AgentSessionRole requires at least one assuming role (the compute role[s] that mint scoped credentials)',
      );
    }

    if (props.assumingRoles?.length && props.deferComputeRoleBinding) {
      throw new Error('Specify assumingRoles or deferComputeRoleBinding, not both');
    }
    this.node.addValidation({ validate: () => this.admittedRoles.size ? [] : ['AgentSessionRole requires an admitted compute role before synthesis'] });
    const firstAssumingRoleArn = props.assumingRoles?.[0]?.roleArn ?? Lazy.string({
      produce: () => {
        const first = this.admittedRoles.values().next().value;
        if (!first) throw new Error('AgentSessionRole requires an admitted compute role before synthesis');
        return first.roleArn;
      },
    });

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ArnPrincipal(firstAssumingRoleArn),
      description:
        'Per-task scoped credentials for ABCA agent tenant-data access '
        + '(DynamoDB task rows + S3 trace/attachment objects), constrained by '
        + 'session tags {user_id, repo, task_id}.',
      // Role chaining hard-caps the session at 1 hour regardless of this value.
      maxSessionDuration: Duration.hours(1),
    });

    // DynamoDB requires ForAllValues for dynamodb:LeadingKeys.
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

    for (const invokable of props.invokableModels ?? []) {
      invokable.grantInvoke(this.role);
    }

    // CDK splits an oversized role policy into managed policies during synthesis; the Aspect visits those too.
    Aspects.of(this.role).add({
      visit(node: IConstruct): void {
        if (!(node instanceof iam.CfnRole || node instanceof iam.CfnPolicy || node instanceof iam.CfnManagedPolicy)) return;
        NagSuppressions.addResourceSuppressions(node, [{
          id: 'AwsSolutions-IAM5',
          reason:
            'Resource wildcards are the per-object suffix under a tenant-scoped '
            + 'prefix (traces/${aws:PrincipalTag/user_id}/*, '
            + 'attachments/${aws:PrincipalTag/user_id}/*, '
            + 'artifacts/${aws:PrincipalTag/task_id}/*). Bedrock grantInvoke uses '
            + 'InvokeModel* for synchronous/streaming invocation and a region '
            + 'wildcard for each literal foundation-model ID routed by a '
            + 'cross-region inference profile, matching the compute role (#215).',
          appliesTo: [
            // cdk-nag renders policy variables as <name> in finding IDs.
            { regex: '/^Resource::[^*?]+/(traces|attachments)/<aws:PrincipalTag/user_id>/\\*$/' },
            { regex: '/^Resource::[^*?]+/artifacts/<aws:PrincipalTag/task_id>/\\*$/' },
            'Action::bedrock:InvokeModel*',
            { regex: '/^Resource::arn:[^*?]+:bedrock:\\*::foundation-model/[^*?]+$/' },
          ],
        }]);
      },
    }, { priority: AspectPriority.MUTATING });

    for (const computeRole of props.assumingRoles ?? []) {
      this.admitComputeRole(computeRole);
    }
  }

  /**
   * Admit a compute role to assume this SessionRole with session tags. Wires
   * both halves AssumeRole requires: trust on this SessionRole and
   * `sts:AssumeRole`/`sts:TagSession` on the compute role's identity policy.
   */
  public admitComputeRole(computeRole: iam.IRole): void {
    if (this.admittedRoles.has(computeRole)) return;
    this.admittedRoles.add(computeRole);
    this.addTrustForComputeRole(computeRole);
    this.grantAssumeToComputeRole(computeRole);
  }

  private addTrustForComputeRole(computeRole: iam.IRole): void {
    this.role.assumeRolePolicy?.addStatements(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        principals: [new iam.ArnPrincipal(computeRole.roleArn)],
      }),
    );
  }

  private grantAssumeToComputeRole(computeRole: iam.IRole): void {
    computeRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['sts:AssumeRole', 'sts:TagSession'],
        resources: [this.role.roleArn],
      }),
    );
  }
}
