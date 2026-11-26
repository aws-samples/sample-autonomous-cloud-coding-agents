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

import { App, AppProps, AspectPriority, Aspects, STACK_RESOURCE_LIMIT_CONTEXT, Stack, Tags } from 'aws-cdk-lib';
import { AWS_CUSTOM_RESOURCE_LATEST_SDK_DEFAULT } from 'aws-cdk-lib/cx-api';
import { AwsSolutionsChecks } from 'cdk-nag';
import { BlueprintDefinition, blueprintEgressDomains, resolveBlueprintDefinitions } from './blueprints/definitions';
import {
  applyAgentCoreAzDiagnostics,
  DescribeAzsFn,
  ResolveCallerAccountFn,
  resolveAgentCoreAzs,
} from './constructs/agentcore-azs';
import { buildAppId, SolutionUaAspect } from './constructs/solution-ua-aspect';
import { assertCapabilitiesAvailable } from './deployment/capabilities';
import { readDeploymentProfile, resolveDeploymentFeatures } from './deployment/features';
import { resolveComputeBackends } from './handlers/shared/compute-backend';
import { AgentStack } from './stacks/agent';
import { DEFAULT_CONSOLE_ASSET_DIRECTORY, OperatorConsoleStack } from './stacks/console';
import { NetworkStack, resolveNetworkTopology } from './stacks/network';
import { DEFAULT_BUDGETS } from './synthesis/budgets';

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
  /** Directory holding `abca.deployment.json`. @default the repository root */
  readonly profileRoot?: string;
  /** Built operator console (`web/dist`). @default undefined — no console stack */
  readonly operatorConsoleAssetDirectory?: string;
}

/**
 * Builds the fully wired `App` **without synthesizing**.
 *
 * Async because AgentCore-supported availability zones are resolved from the
 * account's zone mapping at synth time (live `DescribeAvailabilityZones` +
 * `sts:GetCallerIdentity`) when a concrete account/region is bound. Env-agnostic
 * synth and the validated context override never touch AWS.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<App> {
  const app = new App(options.appProps);
  for (const key of ['blueprintProvisioning', 'guardrailVersionMigration']) {
    if (app.node.tryGetContext(key) !== undefined) {
      throw new Error(
        `Context '${key}' belongs to the deferred migration prototype and is no longer supported. `
        + 'A stack deployed with that prototype needs a separate recovery plan; do not drop this setting and deploy over it.',
      );
    }
  }
  app.node.setContext('@aws-cdk/core:suppressTemplateIndentation', true);
  // Each AwsCustomResource calls AWS with the SDK of the Lambda runtime. The CDK default has
  // it npm-install the latest SDK at deploy time, on every cold start of its provider.
  app.node.setContext(AWS_CUSTOM_RESOURCE_LATEST_SDK_DEFAULT, false);
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
  const profile = readDeploymentProfile(app.node, options.profileRoot);
  const features = resolveDeploymentFeatures(app.node, profile?.features);
  if (profile?.compute && app.node.tryGetContext('compute_types') === undefined
    && app.node.tryGetContext('compute_type') === undefined) {
    app.node.setContext('compute_types', profile.compute.join(','));
  }
  assertCapabilitiesAvailable(features, options.region ?? devEnv.region);

  const env = {
    account: options.account ?? devEnv.account,
    region: options.region ?? devEnv.region,
  };

  // Tag values allow '+', not ','.
  const computeType = resolveComputeBackends(
    app.node.tryGetContext('compute_types'), app.node.tryGetContext('compute_type')).join('+');
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
      features,
      description: 'ABCA Development Stack (uksb-wt64nei4u6)',
    },
  );

  applyAgentCoreAzDiagnostics(network ?? stack, azResolution);

  const consoleContext = app.node.tryGetContext('operatorConsole');
  const consoleEnabled = consoleContext === true || consoleContext === 'true';
  const devOrigins = String(app.node.tryGetContext('operatorConsoleDevOrigins') ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean);
  const consoleStack = options.operatorConsoleAssetDirectory && consoleEnabled
    ? new OperatorConsoleStack(app, `${stackName}-console`, {
      env,
      userPool: stack.taskApi.userPool,
      apiUrl: stack.taskApi.api.url,
      repoTable: stack.repoTable.table,
      githubTokenSecret: stack.githubTokenSecret,
      repoGithubTokenSecretArns: blueprints.flatMap((b) => (b.credentials?.githubTokenSecretArn ? [b.credentials.githubTokenSecretArn] : [])),
      linear: stack.linearIntegration ? {
        projectMappingTable: stack.linearIntegration.projectMappingTable,
        workspaceRegistryTable: stack.linearIntegration.workspaceRegistryTable,
        webhookDedupTable: stack.linearIntegration.webhookDedupTable,
        taskTable: stack.taskTable.table,
        identityVault: stack.linearIdentityVault,
      } : undefined,
      assetDirectory: options.operatorConsoleAssetDirectory,
      additionalOrigins: devOrigins,
      description: 'ABCA operator console (uksb-wt64nei4u6)',
    })
    : undefined;

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

  const deploymentStacks: Stack[] = [network, stack, consoleStack].filter((s) => s !== undefined);
  for (const deploymentStack of deploymentStacks) {
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
  (await buildApp({ operatorConsoleAssetDirectory: DEFAULT_CONSOLE_ASSET_DIRECTORY })).synth();
}

if (require.main === module) {
  void main().catch((err: unknown) => {
    process.exitCode = 1;
    throw err;
  });
}
