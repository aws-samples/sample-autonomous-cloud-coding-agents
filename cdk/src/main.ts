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

import { App, AppProps, AspectPriority, Aspects, STACK_RESOURCE_LIMIT_CONTEXT, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { BlueprintDefinition, blueprintEgressDomains, resolveBlueprintDefinitions } from './blueprints/definitions';
import {
  applyAgentCoreAzDiagnostics,
  DescribeAzsFn,
  ResolveCallerAccountFn,
  resolveAgentCoreAzs,
} from './constructs/agentcore-azs';
import { buildAppId, SolutionUaAspect } from './constructs/solution-ua-aspect';
import { resolveComputeBackend } from './handlers/shared/compute-backend';
import { AgentStack } from './stacks/agent';
import { NetworkStack, resolveNetworkTopology } from './stacks/network';
import { DEFAULT_BUDGETS } from './synthesis/budgets';

// for development, use account/region from cdk cli
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

/** Test seams for {@link buildApp} — all default to production behavior. */
export interface BuildAppOptions {
  /** Target account. @default process.env.CDK_DEFAULT_ACCOUNT */
  readonly account?: string;
  /** Target region. @default process.env.CDK_DEFAULT_REGION */
  readonly region?: string;
  /** Extra `App` props (e.g. `context`) for tests. */
  readonly appProps?: AppProps;
  /** Injectable AZ lookup so tests need no AWS access. */
  readonly describeAzs?: DescribeAzsFn;
  /** Injectable caller-account lookup so tests need no AWS access. */
  readonly resolveCallerAccount?: ResolveCallerAccountFn;
  /** Repository configuration shared by provisioning and DNS policy. */
  readonly blueprints?: readonly BlueprintDefinition[];
}

/**
 * Builds the fully wired `App` **without synthesizing**.
 *
 * Exported so tests can drive the real production wiring — the AZ resolution,
 * the diagnostics attachment, and the prop threading into `AgentStack` — rather
 * than a re-implementation of it in the test file.
 *
 * Async because AgentCore-supported availability zones are resolved from the
 * account's zone mapping at synth time (live `DescribeAvailabilityZones` +
 * `sts:GetCallerIdentity`) when a concrete account/region is bound. Env-agnostic
 * synth and the validated context override never touch AWS.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<App> {
  const app = new App(options.appProps);
  // Apply to every parent and nested template, including newly extracted stacks.
  app.node.setContext('@aws-cdk/core:suppressTemplateIndentation', true);
  // Enforce the same ceiling on actual deploy inputs, including operator overrides
  // outside the census. CDK applies this context to parent and nested stacks.
  const configuredLimit: unknown = app.node.tryGetContext(STACK_RESOURCE_LIMIT_CONTEXT);
  const resourceLimit = configuredLimit === undefined ? DEFAULT_BUDGETS.resources
    : typeof configuredLimit === 'string' ? Number(configuredLimit) : configuredLimit;
  if (typeof resourceLimit !== 'number' || !Number.isInteger(resourceLimit)
    || resourceLimit < 1 || resourceLimit > DEFAULT_BUDGETS.resources) {
    throw new Error(
      `Context '${STACK_RESOURCE_LIMIT_CONTEXT}' must be an integer from 1 to ${DEFAULT_BUDGETS.resources}. `
      + 'The ABCA resource budget can be tightened but not raised. Use networkTopology=split for more '
      + 'application headroom; existing deployments require an explicit network migration.',
    );
  }
  app.node.setContext(STACK_RESOURCE_LIMIT_CONTEXT, resourceLimit);

  Aspects.of(app).add(new AwsSolutionsChecks());

  const stackName = app.node.tryGetContext('stackName') ?? 'backgroundagent-dev';
  const networkTopology = resolveNetworkTopology(app.node.tryGetContext('networkTopology'));
  const blueprints = options.blueprints ?? resolveBlueprintDefinitions(app.node);

  const env = {
    account: options.account ?? devEnv.account,
    region: options.region ?? devEnv.region,
  };

  // Preserve existing VPC placement across backend selection changes. The shared
  // network continues to use the established AgentCore-compatible AZ policy.
  // Auto-pin the VPC to AgentCore-supported AZs (or honor the validated
  // `agentcore:availabilityZones` override). `zones` undefined => CDK default
  // selection; `diagnostics` are attached to the stack below, because CDK only
  // collects annotations that hang off a stack's tree — App-node metadata would
  // be silently dropped, which is how a failed lookup used to pass unnoticed.
  const computeType = resolveComputeBackend(app.node.tryGetContext('compute_type'));
  const azResolution = await resolveAgentCoreAzs({
    node: app.node,
    account: env.account,
    region: env.region,
    describeAzs: options.describeAzs,
    resolveCallerAccount: options.resolveCallerAccount,
  });

  const network = networkTopology === 'split' ? new NetworkStack(app, `${stackName}-network`, {
    env,
    applicationStackName: stackName,
    agentCoreAvailabilityZones: azResolution.zones,
    additionalAllowedDomains: blueprintEgressDomains(blueprints),
    description: 'ABCA network infrastructure (uksb-wt64nei4u6)',
  }) : undefined;

  const stack = new AgentStack(
    app,
    stackName,
    {
      env,
      agentCoreAvailabilityZones: azResolution.zones,
      network,
      blueprints,
      description: 'ABCA Development Stack (uksb-wt64nei4u6)',
    },
  );

  applyAgentCoreAzDiagnostics(network ?? stack, azResolution);

  // Outbound SDK solution attribution (#319): set AWS_SDK_UA_APP_ID on every
  // Lambda so the SDK emits `app/uksb-wt64nei4u6#{stackName}` natively. One
  // Aspect covers current and future functions structurally. Override via
  // `-c sdkUaAppId=...`; `-c sdkUaAppId=''` opts out (no app/ segment anywhere).
  const sdkUaAppIdOverride = app.node.tryGetContext('sdkUaAppId') as string | undefined;
  // Route53 Resolver resources where tag changes trigger replacement cascades.
  // Config: treats ANY property change (including tags) as requiring replacement.
  // Association: depends on Config's physical ID; if Config is replaced, the
  // Association update fails on the one-association-per-VPC constraint.
  const excludeResourceTypes = [
    'AWS::Route53Resolver::ResolverQueryLoggingConfig',
    'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation',
  ];

  const githubTagKeys = [
    'sha',
    'ref',
    'ref-type',
    'actor',
    'head-ref',
    'base-ref',
    'pr-number',
    'run-id',
    'run-attempt',
    'event',
    'workflow',
    'repository',
    'clean',
  ] as const;

  for (const deploymentStack of network ? [network, stack] : [stack]) {
    // Keep the application deployment identity on both stacks' SDK calls.
    Aspects.of(deploymentStack).add(new SolutionUaAspect(buildAppId(stackName, sdkUaAppIdOverride)), {
      priority: AspectPriority.MUTATING,
    });
    Tags.of(deploymentStack).add('compute_type', computeType, { excludeResourceTypes });
    for (const key of githubTagKeys) {
      const value = app.node.tryGetContext(`github:${key}`);
      Tags.of(deploymentStack).add(`github:${key}`, value || 'none', { excludeResourceTypes });
    }
  }

  return app;
}

/** Builds and synthesizes — the CDK app entrypoint (`cdk.json` `app`). */
export async function main(): Promise<void> {
  (await buildApp()).synth();
}

// Only auto-run when executed as the app entrypoint, so importing this module
// from a test drives `buildApp` without triggering a real synth.
/* istanbul ignore next -- entrypoint guard: not reachable under jest import */
if (require.main === module) {
  // Surface any synth-time failure (e.g. a malformed `agentcore:availabilityZones`
  // override) as a non-zero exit. `void` satisfies no-floating-promises; throwing
  // from the handler triggers an unhandled rejection so the CDK CLI fails loudly.
  void main().catch((err: unknown) => {
    process.exitCode = 1;
    throw err;
  });
}
