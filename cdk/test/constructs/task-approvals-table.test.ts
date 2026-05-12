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

import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { TaskApprovalsTable, USER_STATUS_INDEX_NAME } from '../../src/constructs/task-approvals-table';

describe('TaskApprovalsTable', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new TaskApprovalsTable(stack, 'TaskApprovalsTable');
    template = Template.fromStack(stack);
  });

  test('creates a DynamoDB table with task_id PK and request_id SK', () => {
    // §10.1 — PK matches TaskTable.task_id; SK is the ULID minted by
    // the agent. Hard-coding the names here locks the wire contract
    // the Python agent (``task_state.transact_write_approval_request``)
    // and future Lambdas agree on.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'task_id', KeyType: 'HASH' },
        { AttributeName: 'request_id', KeyType: 'RANGE' },
      ],
    });
  });

  test('uses PAY_PER_REQUEST billing mode', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('enables point-in-time recovery by default', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });
  });

  test('uses ttl attribute for row expiry', () => {
    // The agent writes TTL as ``created_at + timeout_s + 120s``. DDB
    // needs the attribute name here to enable the TTL reaper.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'ttl',
        Enabled: true,
      },
    });
  });

  test('does NOT enable DynamoDB streams (§11.2)', () => {
    // Streams deliberately off: TaskEventsTable already carries the
    // audit fan-out. Adding streams here would double-dispatch on
    // every approval transition.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: Match.absent(),
    });
  });

  test('creates user_id-status-index GSI', () => {
    // GSI schema locked by §10.1 / finding #8 — GET /v1/pending does
    // Query by user_id + status=PENDING. Changing this GSI breaks
    // bgagent pending under load.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: USER_STATUS_INDEX_NAME,
          KeySchema: [
            { AttributeName: 'user_id', KeyType: 'HASH' },
            { AttributeName: 'status', KeyType: 'RANGE' },
          ],
          Projection: {
            ProjectionType: 'INCLUDE',
            NonKeyAttributes: Match.arrayWith([
              'task_id',
              'request_id',
              'tool_name',
              'tool_input_preview',
              'severity',
              'reason',
              'created_at',
              'timeout_s',
              // Cedar HITL: surfaced by ``bgagent pending`` so users
              // can see which rule(s) fired on each gate. Projection
              // change after creation is destructive (see construct
              // comment) — locking this into the test prevents a
              // silent regression.
              'matching_rule_ids',
            ]),
          },
        }),
      ]),
    });
  });

  test('GSI does not include deny-sensitive attributes', () => {
    // ``deny_reason``, ``scope``, ``tool_input_sha256`` are deliberately
    // absent from the GSI projection so a GET /v1/pending response does
    // not leak reasons / hashes of already-resolved gates (the list
    // endpoint only surfaces PENDING rows, but a projection leak would
    // cost bytes for no UX gain).
    const tableResource = template.findResources('AWS::DynamoDB::Table');
    const tableProps = Object.values(tableResource)[0].Properties;
    const gsi = tableProps.GlobalSecondaryIndexes.find(
      (index: { IndexName: string }) => index.IndexName === USER_STATUS_INDEX_NAME,
    );
    expect(gsi.Projection.NonKeyAttributes).not.toContain('deny_reason');
    expect(gsi.Projection.NonKeyAttributes).not.toContain('scope');
    expect(gsi.Projection.NonKeyAttributes).not.toContain('tool_input_sha256');
  });

  test('exposes the GSI name via an exported constant', () => {
    // Callers that Query the GSI should reference
    // ``USER_STATUS_INDEX_NAME`` (not a string literal) so a rename
    // in the construct fails compile-time rather than silently at
    // runtime.
    expect(USER_STATUS_INDEX_NAME).toBe('user_id-status-index');
  });

  test('sets DESTROY removal policy by default', () => {
    // Matches task-nudges / task-events convention for sample
    // teardowns. Production callers override to RETAIN per
    // §10.1 recommendation.
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  test('removal policy can be overridden to RETAIN', () => {
    const app = new App();
    const stack = new Stack(app, 'RetainStack');
    new TaskApprovalsTable(stack, 'TaskApprovalsTable', {
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const retainTemplate = Template.fromStack(stack);
    retainTemplate.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('point-in-time recovery can be disabled via props', () => {
    const app = new App();
    const stack = new Stack(app, 'NoPitrStack');
    new TaskApprovalsTable(stack, 'TaskApprovalsTable', {
      pointInTimeRecovery: false,
    });
    const t = Template.fromStack(stack);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: false,
      },
    });
  });

  test('exposes the userStatusIndexName field on the construct', () => {
    // Tests `new TaskApprovalsTable(...).userStatusIndexName` exposes
    // the same constant so handlers with a construct ref do not need
    // to import the module-level export separately.
    const app = new App();
    const stack = new Stack(app, 'FieldStack');
    const approvals = new TaskApprovalsTable(stack, 'TaskApprovalsTable');
    expect(approvals.userStatusIndexName).toBe(USER_STATUS_INDEX_NAME);
  });
});
