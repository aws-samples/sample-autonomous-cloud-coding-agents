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

import { App, Aspects, CfnResource, NestedStack, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { StatefulRetentionAspect } from '../../src/constructs/stateful-retention';

describe('stateful retention before stack decomposition', () => {
  let before: Record<string, any>[];
  let after: Record<string, any>[];

  function synthesize(retain: boolean): Record<string, any>[] {
    const app = new App();
    const stack = new Stack(app, 'Storage');
    const nested = new NestedStack(stack, 'Child');
    const removalPolicy = RemovalPolicy.DESTROY;
    new dynamodb.Table(stack, 'Tasks', { partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING }, removalPolicy });
    new s3.Bucket(nested, 'Artifacts', { removalPolicy, autoDeleteObjects: true });
    new secretsmanager.Secret(stack, 'Token', { removalPolicy });
    new cognito.UserPool(stack, 'Users', { removalPolicy });
    new kms.Key(stack, 'Key', { removalPolicy });
    new logs.LogGroup(stack, 'Logs', { removalPolicy });
    new sqs.Queue(stack, 'FailedTasks', { removalPolicy });
    new sns.Topic(stack, 'Alerts').applyRemovalPolicy(removalPolicy);
    for (const [id, type] of Object.entries({
      Memory: 'AWS::BedrockAgentCore::Memory',
      Registry: 'Custom::AgentRegistry',
      Vault: 'Custom::LinearWorkloadIdentity',
      Deployment: 'Custom::CDKBucketDeployment',
    })) {
      new CfnResource(nested, id, { type });
    }
    new iam.Role(stack, 'Compute', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    if (retain) Aspects.of(stack).add(new StatefulRetentionAspect());
    return [Template.fromStack(stack).toJSON().Resources, Template.fromStack(nested).toJSON().Resources];
  }

  beforeAll(() => { before = synthesize(false); after = synthesize(true); });

  test('retains data, encryption keys and cleanup helpers through deletion and replacement', () => {
    const resources = after.flatMap(template => Object.values(template));
    const types = [
      'AWS::DynamoDB::Table', 'AWS::S3::Bucket', 'AWS::SecretsManager::Secret',
      'AWS::Cognito::UserPool', 'AWS::KMS::Key', 'AWS::Logs::LogGroup',
      'AWS::SQS::Queue', 'AWS::SNS::Topic', 'AWS::BedrockAgentCore::Memory',
      'Custom::AgentRegistry', 'Custom::LinearWorkloadIdentity',
      'Custom::S3AutoDeleteObjects', 'Custom::CDKBucketDeployment',
    ];
    for (const type of types) {
      const matching = resources.filter(resource => resource.Type === type);
      expect(matching.length).toBeGreaterThan(0);
      for (const resource of matching) {
        expect(resource).toMatchObject({ DeletionPolicy: 'Retain', UpdateReplacePolicy: 'Retain' });
      }
    }
  });

  test('changes no resource identity or service properties, including the live S3 cleanup helper', () => {
    const withoutPolicies = (resource: any): unknown => {
      const copy = structuredClone(resource);
      delete copy.DeletionPolicy;
      delete copy.UpdateReplacePolicy;
      // A nested template containing the new policies has a different asset hash.
      if (copy.Type === 'AWS::CloudFormation::Stack') delete copy.Properties.TemplateURL;
      return copy;
    };
    for (const [index, template] of after.entries()) {
      expect(Object.keys(template)).toEqual(Object.keys(before[index]));
      for (const [id, resource] of Object.entries(template)) {
        expect(withoutPolicies(resource)).toEqual(withoutPolicies(before[index][id]));
      }
    }
  });

  test('does not retain compute roles or nested stack containers', () => {
    for (const template of after) {
      for (const resource of Object.values(template)) {
        if (resource.Type === 'AWS::IAM::Role' || resource.Type === 'AWS::CloudFormation::Stack') {
          expect(resource.DeletionPolicy).not.toBe('Retain');
        }
      }
    }
  });
});
