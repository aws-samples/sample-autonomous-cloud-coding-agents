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

import { CfnResource, IAspect, RemovalPolicy } from 'aws-cdk-lib';
import { IConstruct } from 'constructs';

// Protect data and the keys needed to recover it before changing stack ownership.
// Cleanup providers must be retained too: retaining only an S3 bucket still lets
// its custom resource empty the bucket when CloudFormation removes that helper.
const RETAINED_TYPES = new Set([
  'AWS::DynamoDB::Table',
  'AWS::S3::Bucket',
  'AWS::SecretsManager::Secret',
  'AWS::Cognito::UserPool',
  'AWS::KMS::Key',
  'AWS::Logs::LogGroup',
  'AWS::SQS::Queue',
  'AWS::SNS::Topic',
  'AWS::BedrockAgentCore::Memory',
  'Custom::AgentRegistry',
  'Custom::LinearWorkloadIdentity',
  'Custom::S3AutoDeleteObjects',
  'Custom::CDKBucketDeployment',
]);

export function requiresStatefulRetention(resourceType: string): boolean {
  return RETAINED_TYPES.has(resourceType);
}

/** Applies only lifecycle policies; preserves construct paths, properties and IAM. */
export class StatefulRetentionAspect implements IAspect {
  visit(node: IConstruct): void {
    if (CfnResource.isCfnResource(node) && requiresStatefulRetention(node.cfnResourceType)) {
      if (node.cfnResourceType === 'AWS::S3::Bucket') {
        // The Bucket L2 requires DESTROY while autoDeleteObjects is configured,
        // even if its cleanup helper is retained. Removing that helper in this
        // update could invoke its live Delete callback. Keep both identities and
        // override the emitted attributes instead; the helper is retained below.
        node.addOverride('DeletionPolicy', 'Retain');
        node.addOverride('UpdateReplacePolicy', 'Retain');
      } else {
        node.applyRemovalPolicy(RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });
      }
    }
  }
}
