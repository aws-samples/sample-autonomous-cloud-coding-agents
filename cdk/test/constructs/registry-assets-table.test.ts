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
import {
  REGISTRY_KIND_INDEX,
  RegistryAssetsTable,
} from '../../src/constructs/registry-assets-table';

describe('RegistryAssetsTable', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new RegistryAssetsTable(stack, 'RegistryAssetsTable');
    template = Template.fromStack(stack);
  });

  test('creates a table with a composite pk/sk key schema', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    });
  });

  test('uses on-demand billing', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('defines the kind-index GSI (kind HASH, pk RANGE) with ALL projection', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: REGISTRY_KIND_INDEX,
          KeySchema: [
            { AttributeName: 'kind', KeyType: 'HASH' },
            { AttributeName: 'pk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  test('declares the attribute definitions the base key and GSI need', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'kind', AttributeType: 'S' },
      ]),
    });
  });

  test('enables point-in-time recovery by default', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test('does NOT configure a TTL (records are immutable + audited, not expired)', () => {
    const tables = template.findResources('AWS::DynamoDB::Table');
    const [table] = Object.values(tables);
    expect(table.Properties.TimeToLiveSpecification).toBeUndefined();
  });

  test('sets DESTROY removal policy by default', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  test('exposes a table handle via the `table` property', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const t = new RegistryAssetsTable(stack, 'RegistryAssetsTable');
    expect(t.table).toBeDefined();
    expect(t.table.tableName).toBeDefined();
  });
});

describe('RegistryAssetsTable with custom props', () => {
  test('accepts a RETAIN removal policy and disables PITR', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new RegistryAssetsTable(stack, 'RegistryAssetsTable', {
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecovery: false,
    });
    const template = Template.fromStack(stack);

    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    });
  });
});
