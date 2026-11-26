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

import * as path from 'path';
import { CfnResource, CustomResource, Duration, NestedStack, type NestedStackProps, Stack, Token } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const PROVISION_TIMEOUT_SECONDS = 60;
const PROVISION_MEMORY_MB = 256;
const POLL_INTERVAL_SECONDS = 10;
const TOTAL_TIMEOUT_MINUTES = 15;
const POLL_INTERVAL = Duration.seconds(POLL_INTERVAL_SECONDS);
const TOTAL_TIMEOUT = Duration.minutes(TOTAL_TIMEOUT_MINUTES);
const STATE_MACHINE_NAME_MAX = 80;

export interface AgentRegistryProps {
  /** Registry name — unique per account, alphanumerics + underscores. */
  readonly registryName: string;
  readonly description?: string;
}

/**
 * Provisions the AWS Agent Registry through a custom resource and exposes
 * its id and ARN.
 */
export class AgentRegistry extends Construct {
  public readonly registryId: string;
  public readonly registryArn: string;

  constructor(scope: Construct, id: string, props: AgentRegistryProps) {
    super(scope, id);

    const entry = path.join(__dirname, '..', 'handlers', 'registry-provisioning', 'index.ts');
    const bundling = { externalModules: [] as string[] };

    const commonFnProps = {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(PROVISION_TIMEOUT_SECONDS),
      memorySize: PROVISION_MEMORY_MB,
      bundling,
      environment: { ABCA_COMPONENT: 'registry-provisioning' },
    };

    const onEventFn = new lambda.NodejsFunction(this, 'OnEventFn', {
      ...commonFnProps,
      entry,
      handler: 'onEvent',
    });
    const isCompleteFn = new lambda.NodejsFunction(this, 'IsCompleteFn', {
      ...commonFnProps,
      entry,
      handler: 'isComplete',
    });

    const createPolicy = new iam.PolicyStatement({
      actions: ['agent-registry:CreateRegistry'],
      resources: ['*'],
    });
    // DeleteRegistry is refused while the registry holds a record. `registry/*` also
    // matches the ARN of a record, `registry/<registry id>/record/<record id>`.
    const registryPolicy = new iam.PolicyStatement({
      actions: [
        'agent-registry:GetRegistry',
        'agent-registry:UpdateRegistry',
        'agent-registry:DeleteRegistry',
        'agent-registry:ListRegistryRecords',
        'agent-registry:DeleteRegistryRecord',
      ],
      resources: [
        Stack.of(this).formatArn({
          service: 'agent-registry',
          resource: 'registry',
          resourceName: '*',
        }),
      ],
    });
    const serviceLinkedRolePolicy = new iam.PolicyStatement({
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'iam:AWSServiceName': 'agent-registry.amazonaws.com',
        },
      },
    });
    // Agent Registry calls these AgentCore workload-identity APIs using the
    // caller's credentials during CreateRegistry and DeleteRegistry.
    const workloadIdentityPolicy = new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateWorkloadIdentity',
        'bedrock-agentcore:GetWorkloadIdentity',
        'bedrock-agentcore:DeleteWorkloadIdentity',
      ],
      resources: [
        Stack.of(this).formatArn({
          service: 'bedrock-agentcore',
          resource: 'workload-identity-directory',
          resourceName: '*',
        }),
      ],
    });
    onEventFn.addToRolePolicy(serviceLinkedRolePolicy);
    for (const fn of [onEventFn, isCompleteFn]) {
      fn.addToRolePolicy(createPolicy);
      fn.addToRolePolicy(registryPolicy);
      fn.addToRolePolicy(workloadIdentityPolicy);
    }

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEventFn,
      isCompleteHandler: isCompleteFn,
      queryInterval: POLL_INTERVAL,
      totalTimeout: TOTAL_TIMEOUT,
    });

    // CloudFormation names an unnamed state machine `<LogicalId>-<random>`,
    // without the stack name.
    const root = Stack.of(this).nestedStackParent ?? Stack.of(this);
    const waiter = provider.node
      .findAll()
      .find(
        (c): c is CfnResource =>
          c instanceof CfnResource && c.cfnResourceType === 'AWS::StepFunctions::StateMachine',
      );
    if (!waiter) {
      throw new Error(
        'AgentRegistry: Provider framework no longer synthesizes a waiter state machine; '
          + 'revisit the least-privilege naming override',
      );
    }
    const waiterName = `${root.stackName}-AgentRegistryWaiter`;
    waiter.addPropertyOverride(
      'StateMachineName',
      Token.isUnresolved(waiterName) ? waiterName : waiterName.slice(0, STATE_MACHINE_NAME_MAX),
    );

    const resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::AgentRegistry',
      properties: {
        RegistryName: props.registryName,
        Description: props.description ?? '',
      },
    });

    this.registryId = resource.getAttString('RegistryId');
    this.registryArn = resource.getAttString('RegistryArn');

    NagSuppressions.addResourceSuppressions(
      [onEventFn, isCompleteFn],
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole is required for CloudWatch Logs access',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CreateRegistry is an account-level action authorized against `*` '
            + '(no registry exists yet at create time). CreateServiceLinkedRole is '
            + 'restricted to agent-registry.amazonaws.com by iam:AWSServiceName. '
            + 'Workload identity lifecycle actions use workload-identity-directory/*, and '
            + 'Get/Update/DeleteRegistry, ListRegistryRecords and DeleteRegistryRecord use '
            + 'registry/* because the registry and record ids are server-assigned and unknown at synth.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      provider,
      [
        {
          id: 'AwsSolutions-SF1',
          reason: 'Provider-framework waiter state machine; logging config is managed by the CDK custom-resources framework',
        },
        {
          id: 'AwsSolutions-SF2',
          reason: 'Provider-framework waiter state machine; X-Ray config is managed by the CDK custom-resources framework',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Provider-framework Lambdas use AWS managed AWSLambdaBasicExecutionRole — required by the CDK custom-resources framework',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Provider-framework grants InvokeFunction on the user handler versions (Arn:*) — generated by the CDK custom-resources framework',
        },
      ],
      true,
    );
  }
}

/**
 * NestedStack wrapper for {@link AgentRegistry}: its resources count against
 * the nested stack's 500-resource CloudFormation limit, not the root's.
 */
export class AgentRegistryStack extends NestedStack {
  public readonly registryId: string;
  public readonly registryArn: string;

  constructor(scope: Construct, id: string, props: AgentRegistryProps & NestedStackProps) {
    super(scope, id, props);
    const registry = new AgentRegistry(this, 'AgentRegistry', {
      registryName: props.registryName,
      description: props.description,
    });
    this.registryId = registry.registryId;
    this.registryArn = registry.registryArn;
  }
}
