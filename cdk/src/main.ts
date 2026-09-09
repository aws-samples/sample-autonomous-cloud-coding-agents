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

import { App, AppProps, AspectPriority, Aspects, Tags } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import {
  applyAgentCoreAzDiagnostics,
  DescribeAzsFn,
  ResolveCallerAccountFn,
  resolveAgentCoreAzs,
} from './constructs/agentcore-azs';
import { buildAppId, SolutionUaAspect } from './constructs/solution-ua-aspect';
import { AgentStack } from './stacks/agent';

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

  Aspects.of(app).add(new AwsSolutionsChecks());

  const stackName = app.node.tryGetContext('stackName') ?? 'backgroundagent-dev';

  const env = {
    account: options.account ?? devEnv.account,
    region: options.region ?? devEnv.region,
  };

  // Auto-pin the VPC to AgentCore-supported AZs (or honor the validated
  // `agentcore:availabilityZones` override). `zones` undefined => CDK default
  // selection; `diagnostics` are attached to the stack below, because CDK only
  // collects annotations that hang off a stack's tree — App-node metadata would
  // be silently dropped, which is how a failed lookup used to pass unnoticed.
  const azResolution = await resolveAgentCoreAzs({
    node: app.node,
    account: env.account,
    region: env.region,
    describeAzs: options.describeAzs,
    resolveCallerAccount: options.resolveCallerAccount,
  });

  const stack = new AgentStack(
    app,
    stackName,
    {
      env,
      agentCoreAvailabilityZones: azResolution.zones,
      description: 'ABCA Development Stack (uksb-wt64nei4u6)',
      // Emit compact JSON for a CloudFormation 1 MB template-body ceiling.
      suppressTemplateIndentation: true,
    },
  );

  applyAgentCoreAzDiagnostics(stack, azResolution);

  // Outbound SDK solution attribution (#319): set AWS_SDK_UA_APP_ID on every
  // Lambda so the SDK emits `app/uksb-wt64nei4u6#{stackName}` natively. One
  // Aspect covers current and future functions structurally. Override via
  // `-c sdkUaAppId=...`; `-c sdkUaAppId=''` opts out (no app/ segment anywhere).
  const sdkUaAppIdOverride = app.node.tryGetContext('sdkUaAppId') as string | undefined;
  // MUTATING priority so the env var is set before cdk-nag (priority 500)
  // inspects the synthesized functions — matches the agent stack's aspects.
  Aspects.of(stack).add(new SolutionUaAspect(buildAppId(stackName, sdkUaAppIdOverride)), {
    priority: AspectPriority.MUTATING,
  });

  const computeType = app.node.tryGetContext('compute_type') ?? 'agentcore';

  // Route53 Resolver resources where tag changes trigger replacement cascades.
  // Config: treats ANY property change (including tags) as requiring replacement.
  // Association: depends on Config's physical ID; if Config is replaced, the
  // Association update fails on the one-association-per-VPC constraint.
  const excludeResourceTypes = [
    'AWS::Route53Resolver::ResolverQueryLoggingConfig',
    'AWS::Route53Resolver::ResolverQueryLoggingConfigAssociation',
  ];

  // TODO(#645): with three backends this single-valued tag is no longer an honest
  // statement of what a stack runs — a `--context compute_type=lambda-microvm`
  // deploy still provisions the AgentCore runtime, so every resource gets tagged
  // `compute_type=lambda-microvm` including the AgentCore ones. ADR-021
  // sub-decision 4 flags revisiting the semantics (e.g. a `compute_types` list).
  // Deliberately NOT changed here: retagging every resource in the stack is a
  // replacement-risk change of its own, and MicroVM spend is already attributable
  // through the per-resource `abca:compute-backend` tags the
  // LambdaMicrovmCompute construct applies.
  Tags.of(stack).add('compute_type', computeType, { excludeResourceTypes });

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

  for (const key of githubTagKeys) {
    const value = app.node.tryGetContext(`github:${key}`);
    Tags.of(stack).add(`github:${key}`, value || 'none', { excludeResourceTypes });
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
