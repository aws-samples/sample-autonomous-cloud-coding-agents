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

import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { SlackUserMappingTable } from '../../src/constructs/slack-user-mapping-table';

describe('SlackUserMappingTable', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new SlackUserMappingTable(stack, 'SlackUserMappingTable');
    template = Template.fromStack(stack);
  });

  test('creates a DynamoDB table with slack_user_id as the sole key', () => {
    // §11.2 — PK only, no SK. One row per Slack identity; the
    // `ConditionExpression: attribute_not_exists` on the link Lambda
    // prevents overwrites.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'slack_user_id', KeyType: 'HASH' },
      ],
    });
  });

  test('has no sort key', () => {
    const resources = template.findResources('AWS::DynamoDB::Table');
    const tableProps = Object.values(resources)[0].Properties;
    // A schema with only HASH is encoded as a single-element KeySchema.
    expect(tableProps.KeySchema).toHaveLength(1);
    expect(tableProps.KeySchema[0].KeyType).toBe('HASH');
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

  test('does NOT enable streams (no fan-out consumer)', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      StreamSpecification: Match.absent(),
    });
  });

  test('does NOT create a reverse Cognito → Slack GSI', () => {
    // §11.2: only forward (slack_user_id → cognito_sub) is
    // trust-sensitive. Adding a reverse GSI would let an attacker
    // enumerate Slack identities from a compromised Cognito sub
    // without adding capability we need in v1.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.absent(),
    });
  });

  test('sets DESTROY removal policy by default', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  test('uses TTL attribute is NOT set (mappings do not expire)', () => {
    // Unlike approvals, Slack links persist indefinitely — a TTL would
    // silently break approvals for users who set up Slack and then
    // left the system idle for > TTL period.
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: Match.absent(),
    });
  });
});
