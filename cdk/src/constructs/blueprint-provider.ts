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

import * as path from 'node:path';
import { Duration, NestedStack, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const HANDLER_TIMEOUT_SECONDS = 30;
const HANDLER_MEMORY_MB = 256;

/** One provider per owning stack; its helpers do not consume the nearly-full root's quota. */
export class BlueprintProvider extends NestedStack {
  public static forScope(scope: Construct, repoTable: dynamodb.ITable): BlueprintProvider {
    const stack = Stack.of(scope);
    const existing = stack.node.tryFindChild('BlueprintProvisioning');
    if (existing && !(existing instanceof BlueprintProvider)) throw new Error('BlueprintProvisioning construct ID is already in use');
    const provider = existing ?? new BlueprintProvider(stack, 'BlueprintProvisioning');
    // TransactWriteItems authorizes its constituent UpdateItem/ConditionCheckItem operations.
    repoTable.grant(provider.handler, 'dynamodb:UpdateItem', 'dynamodb:GetItem', 'dynamodb:ConditionCheckItem');
    return provider;
  }

  public readonly serviceToken: string;
  private readonly handler: NodejsFunction;

  private constructor(scope: Construct, id: string) {
    super(scope, id);
    const ledger = new dynamodb.Table(this, 'Ownership', {
      partitionKey: { name: 'target', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Operational coordination state. The parent custom resources finish deletion
      // before this provider stack can be deleted through their service-token dependency.
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.handler = new NodejsFunction(this, 'OnEvent', {
      entry: path.join(__dirname, '../handlers/blueprint-provisioning/index.ts'),
      handler: 'onEvent',
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(HANDLER_TIMEOUT_SECONDS),
      memorySize: HANDLER_MEMORY_MB,
      bundling: { externalModules: [] },
      environment: { OWNERSHIP_TABLE: ledger.tableName, ABCA_COMPONENT: 'blueprint-provisioning' },
    });
    ledger.grant(this.handler, 'dynamodb:GetItem', 'dynamodb:UpdateItem', 'dynamodb:PutItem');
    const provider = new Provider(this, 'Provider', { onEventHandler: this.handler });
    this.serviceToken = provider.serviceToken;
    NagSuppressions.addResourceSuppressions(this.handler, [
      { id: 'AwsSolutions-IAM4', reason: 'AWSLambdaBasicExecutionRole provides CloudWatch Logs access for the provisioning handler' },
    ], true);
    NagSuppressions.addResourceSuppressions(provider, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK custom-resources framework Lambda role' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK provider framework invokes the onEvent function and its qualified versions' },
      { id: 'AwsSolutions-L1', reason: 'CDK custom-resources framework manages its Lambda runtime' },
    ], true);
  }
}
