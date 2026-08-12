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

// Provisions the AgentCore registry that backs the agent asset registry (#246).
//
// CreateRegistry is asynchronous (CREATING -> READY, ~70s observed) and there is
// no CDK L1/L2 construct for it during preview, so this wraps the CDK Provider
// framework: an `onEvent` Lambda starts the mutation and an `isComplete` Lambda is
// polled until the registry reaches a stable state.
//
// GA-THROWAWAY: replace this whole construct with the native AgentCore CDK
// construct once it ships (~2026-08-06). Everything downstream talks to the
// registry through the `RegistryClient` seam, so this swap is self-contained.
import * as path from 'path';
import { CustomResource, Duration, NestedStack, type NestedStackProps, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import * as lambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

const PROVISION_TIMEOUT_SECONDS = 60;
const PROVISION_MEMORY_MB = 256;
// Registry create observed at ~70s; poll generously and cap the total wait.
const POLL_INTERVAL_SECONDS = 10;
const TOTAL_TIMEOUT_MINUTES = 15;
const POLL_INTERVAL = Duration.seconds(POLL_INTERVAL_SECONDS);
const TOTAL_TIMEOUT = Duration.minutes(TOTAL_TIMEOUT_MINUTES);

export interface AgentRegistryProps {
  /** Registry name — unique per account, alphanumerics + underscores. */
  readonly registryName: string;
  /** Optional human description stored on the registry. */
  readonly description?: string;
}

/**
 * The AgentCore registry resource. Exposes {@link registryId} / {@link registryArn}
 * for handlers and the `RegistryClient` adapter to target.
 */
export class AgentRegistry extends Construct {
  public readonly registryId: string;
  public readonly registryArn: string;

  constructor(scope: Construct, id: string, props: AgentRegistryProps) {
    super(scope, id);

    const entry = path.join(__dirname, '..', 'handlers', 'registry-provisioning', 'index.ts');
    // The AgentCore control-plane SDK is preview and NOT in the Lambda runtime, so
    // it must be bundled (the repo default externalizes @aws-sdk/*, which we override).
    const bundling = { externalModules: [] as string[] };

    const commonFnProps = {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(PROVISION_TIMEOUT_SECONDS),
      memorySize: PROVISION_MEMORY_MB,
      bundling,
      // Names this component in the solution UA segment (#319) instead of
      // falling through to the generic `api` default.
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

    // Account-level actions authorized against the account ARN (`:*`), NOT a
    // `registry/{id}` ARN — at call time the target resource does not exist yet.
    // Scoping these to `registry/*` fails with AccessDenied (observed on deploy).
    //   - CreateRegistry/ListRegistries: no registry exists at create time.
    //   - CreateRegistry ALSO provisions a workload identity under the hood, so
    //     the role needs the WorkloadIdentity create/get/delete actions too —
    //     the registry lands in CREATE_FAILED ("Unable to create workload
    //     identity because access was denied") without them.
    const createPolicy = new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:CreateRegistry',
        'bedrock-agentcore:ListRegistries',
        'bedrock-agentcore:CreateWorkloadIdentity',
        'bedrock-agentcore:GetWorkloadIdentity',
        'bedrock-agentcore:DeleteWorkloadIdentity',
      ],
      resources: ['*'],
    });
    const registryPolicy = new iam.PolicyStatement({
      actions: [
        'bedrock-agentcore:GetRegistry',
        'bedrock-agentcore:UpdateRegistry',
        'bedrock-agentcore:DeleteRegistry',
        'bedrock-agentcore:ListRegistryRecords',
        'bedrock-agentcore:DeleteRegistryRecord',
      ],
      resources: [
        Stack.of(this).formatArn({
          service: 'bedrock-agentcore',
          resource: 'registry',
          resourceName: '*',
        }),
        Stack.of(this).formatArn({
          service: 'bedrock-agentcore',
          resource: 'registry',
          resourceName: '*/record/*',
        }),
      ],
    });
    for (const fn of [onEventFn, isCompleteFn]) {
      fn.addToRolePolicy(createPolicy);
      fn.addToRolePolicy(registryPolicy);
    }

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: onEventFn,
      isCompleteHandler: isCompleteFn,
      queryInterval: POLL_INTERVAL,
      totalTimeout: TOTAL_TIMEOUT,
    });

    const resource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::AgentCoreRegistry',
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
            'CreateRegistry/ListRegistries are account-level actions authorized against '
            + '`*` (no registry exists yet at create time). GetRegistry/DeleteRegistry + '
            + 'record actions use registry/* and registry/*/record/* wildcards because the '
            + 'registry id and record ids are server-assigned and unknown at synth.',
        },
      ],
      true,
    );

    // The CDK Provider framework synthesizes its own waiter state machine and
    // framework Lambdas (onEvent/isComplete/onTimeout) that we do not author.
    // These findings are on framework-managed resources; GA-throwaway anyway.
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
 * NestedStack wrapper for {@link AgentRegistry} (#246).
 *
 * The registry + its Provider framework (custom-resource Lambdas, IAM roles,
 * Step Functions waiter) contribute ~20 resources. Nesting them keeps the root
 * ``AgentStack`` under CloudFormation's hard 500-resource-per-stack limit — the
 * nested stack gets its own budget. ``registryId``/``registryArn`` are surfaced
 * so the parent can thread them into the orchestrator + TaskApi exactly as
 * before (CDK auto-wires the cross-stack export/import).
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
