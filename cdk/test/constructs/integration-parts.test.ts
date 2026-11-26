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
import { Template } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';
import { integrationTable, webhookDedupTable } from '../../src/constructs/integration-parts';

/** The tables that `build` creates under a construct with the deployed id `LinearIntegration`, by logical ID. */
function tablesUnderLinearIntegration(build: (parent: Construct) => void): Record<string, Record<string, any>> {
  const stack = new Stack(new App(), 'TestStack');
  build(new Construct(stack, 'LinearIntegration'));
  return Template.fromStack(stack).findResources('AWS::DynamoDB::Table');
}

describe('integrationTable', () => {
  test('without options: the whole resource, under the logical ID a deployed stack holds', () => {
    const tables = tablesUnderLinearIntegration((parent) => {
      integrationTable(parent, 'ProjectMappingTable', { partitionKey: 'linear_project_id', removalPolicy: RemovalPolicy.DESTROY });
    });

    expect(tables).toEqual({
      LinearIntegrationProjectMappingTableF152E008: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          AttributeDefinitions: [{ AttributeName: 'linear_project_id', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [{ AttributeName: 'linear_project_id', KeyType: 'HASH' }],
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        },
        UpdateReplacePolicy: 'Delete',
        DeletionPolicy: 'Delete',
      },
    });
  });

  test('ttl alone adds the TTL attribute and no index', () => {
    const [table] = Object.values(tablesUnderLinearIntegration((parent) => {
      integrationTable(parent, 'InstallationTable', { partitionKey: 'team_id', ttl: true, removalPolicy: RemovalPolicy.DESTROY });
    }));

    expect(table.Properties.TimeToLiveSpecification).toEqual({ AttributeName: 'ttl', Enabled: true });
    expect(table.Properties.GlobalSecondaryIndexes).toBeUndefined();
  });

  test('platformUserIndex alone adds the index and no TTL attribute; the removal policy is the given one', () => {
    const [table] = Object.values(tablesUnderLinearIntegration((parent) => {
      integrationTable(parent, 'UserMappingTable', {
        partitionKey: 'linear_identity', platformUserIndex: true, removalPolicy: RemovalPolicy.RETAIN,
      });
    }));

    expect(table.Properties.AttributeDefinitions).toEqual([
      { AttributeName: 'linear_identity', AttributeType: 'S' },
      { AttributeName: 'platform_user_id', AttributeType: 'S' },
      { AttributeName: 'linked_at', AttributeType: 'S' },
    ]);
    expect(table.Properties.GlobalSecondaryIndexes).toEqual([{
      IndexName: 'PlatformUserIndex',
      KeySchema: [
        { AttributeName: 'platform_user_id', KeyType: 'HASH' },
        { AttributeName: 'linked_at', KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    }]);
    expect(table.Properties.TimeToLiveSpecification).toBeUndefined();
    expect(table).toMatchObject({ UpdateReplacePolicy: 'Retain', DeletionPolicy: 'Retain' });
  });
});

describe('webhookDedupTable', () => {
  test('the whole resource, under the logical ID a deployed stack holds', () => {
    const tables = tablesUnderLinearIntegration((parent) => {
      webhookDedupTable(parent, RemovalPolicy.DESTROY);
    });

    expect(tables).toEqual({
      LinearIntegrationWebhookDedupTable1162175A: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          AttributeDefinitions: [{ AttributeName: 'dedup_key', AttributeType: 'S' }],
          BillingMode: 'PAY_PER_REQUEST',
          KeySchema: [{ AttributeName: 'dedup_key', KeyType: 'HASH' }],
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
        },
        UpdateReplacePolicy: 'Delete',
        DeletionPolicy: 'Delete',
      },
    });
  });

  test('the removal policy is the given one', () => {
    const [table] = Object.values(tablesUnderLinearIntegration((parent) => {
      webhookDedupTable(parent, RemovalPolicy.RETAIN);
    }));

    expect(table).toMatchObject({ UpdateReplacePolicy: 'Retain', DeletionPolicy: 'Retain' });
  });
});
