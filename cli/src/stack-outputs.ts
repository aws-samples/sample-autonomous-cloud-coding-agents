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

import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CliError } from './errors';
import { CliConfig } from './types';
import { makeClient } from './ua';

export interface StackOutputEntry {
  readonly key: string;
  readonly value: string;
  readonly description?: string;
}

/** Resolve AWS region for operator commands (flag → config → env). */
export function resolveOperatorRegion(opts: { region?: string }, configuredRegion?: string): string {
  const region = opts.region ?? configuredRegion ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    throw new CliError(
      'AWS region is required. Pass --region, run `bgagent configure --region …`, or set AWS_REGION.',
    );
  }
  return region;
}

async function describeStack(region: string, stackName: string) {
  const cf = makeClient(CloudFormationClient, { region });
  try {
    const result = await cf.send(new DescribeStacksCommand({ StackName: stackName }));
    const stack = result.Stacks?.[0];
    if (!stack) {
      throw new CliError(`Stack '${stackName}' was not found in ${region}.`);
    }
    return stack;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      `Could not describe stack '${stackName}' in ${region}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read all CloudFormation stack outputs. */
export async function listStackOutputs(region: string, stackName: string): Promise<StackOutputEntry[]> {
  const stack = await describeStack(region, stackName);
  return (stack.Outputs ?? [])
    .filter((o): o is typeof o & { OutputKey: string; OutputValue: string } =>
      Boolean(o.OutputKey && o.OutputValue))
    .map((o) => ({
      key: o.OutputKey,
      value: o.OutputValue,
      description: o.Description,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const REQUIRED_CONFIGURE_OUTPUT_KEYS = ['ApiUrl', 'UserPoolId', 'AppClientId'] as const;

/**
 * Resolve configure fields from stack outputs.
 * Returns null when any required output is missing (used by operator pre-configure flows).
 */
export async function resolveConfigureBundleFromStack(
  region: string,
  stackName: string,
): Promise<CliConfig | null> {
  const outputs = await listStackOutputs(region, stackName);
  const byKey = new Map(outputs.map((o) => [o.key, o.value]));
  const apiUrl = byKey.get('ApiUrl');
  const registryApiUrl = byKey.get('RegistryApiUrl');
  const userPoolId = byKey.get('UserPoolId');
  const appClientId = byKey.get('AppClientId');
  if (!apiUrl || !userPoolId || !appClientId) {
    return null;
  }
  return {
    api_url: apiUrl,
    // Optional: only present once the registry (#246) is deployed. `bgagent
    // registry` commands require it; other commands don't.
    ...(registryApiUrl ? { registry_api_url: registryApiUrl } : {}),
    region,
    user_pool_id: userPoolId,
    client_id: appClientId,
  };
}

/** Like {@link resolveConfigureBundleFromStack} but fails when outputs are incomplete. */
export async function fetchConfigureBundleFromStack(
  region: string,
  stackName: string,
): Promise<CliConfig> {
  const bundle = await resolveConfigureBundleFromStack(region, stackName);
  if (bundle) {
    return bundle;
  }
  const outputs = await listStackOutputs(region, stackName);
  const byKey = new Map(outputs.map((o) => [o.key, o.value]));
  const missing = REQUIRED_CONFIGURE_OUTPUT_KEYS.filter((key) => !byKey.get(key));
  throw new CliError(
    `Stack '${stackName}' is missing configure outputs in ${region}: ${missing.join(', ')}. `
    + 'Deploy the stack or pass --api-url / --user-pool-id / --client-id explicitly.',
  );
}

/**
 * Read several CloudFormation stack outputs with one DescribeStacks call.
 *
 * The result is keyed by output name, with null for an output the stack does not have.
 * A command that needs more than one output asks for them together: one
 * {@link getStackOutput} per key describes the whole stack once per key.
 */
export async function getStackOutputs<K extends string>(
  region: string,
  stackName: string,
  outputKeys: readonly K[],
): Promise<Record<K, string | null>> {
  const stack = await describeStack(region, stackName);
  return Object.fromEntries(outputKeys.map(
    (key) => [key, stack.Outputs?.find((o) => o.OutputKey === key)?.OutputValue ?? null],
  )) as Record<K, string | null>;
}

/** Read a single CloudFormation stack output by key. */
export async function getStackOutput(
  region: string,
  stackName: string,
  outputKey: string,
): Promise<string | null> {
  const outputs = await getStackOutputs(region, stackName, [outputKey]);
  return outputs[outputKey];
}

/**
 * Read a single stack output: null when the stack has no such output, or does not exist.
 *
 * Where {@link getStackOutput} fails on a missing stack, this takes it as an answer: the
 * integration commands also run before the stack, or the part of it they ask about, is
 * deployed. Any other failure (credentials, permissions, region) is rethrown as the SDK
 * raised it, so that it cannot pass for "not deployed".
 */
export async function findStackOutput(region: string, stackName: string, outputKey: string): Promise<string | null> {
  const outputs = await outputsIfDeployed(region, stackName);
  return outputs.find((o) => o.OutputKey === outputKey)?.OutputValue ?? null;
}

/** The outputs of a stack: none when the stack does not exist, where {@link describeStack} fails. */
async function outputsIfDeployed(region: string, stackName: string) {
  try {
    const cfn = makeClient(CloudFormationClient, { region });
    const result = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    return result.Stacks?.[0]?.Outputs ?? [];
  } catch (err) {
    const name = (err as Error)?.name ?? '';
    const message = (err as Error)?.message ?? '';
    if (name === 'ValidationError' && /does not exist/i.test(message)) {
      return []; // "stack does not exist" is the not-deployed-yet contract; auth/other errors rethrow below
    }
    throw err;
  }
}

/**
 * Read the stack outputs a command cannot run without, with one DescribeStacks call.
 *
 * Fails with a CliError that names the outputs without a value (all of them when the stack
 * does not exist), followed by `redeployHint`. Any other failure is rethrown as the SDK raised it.
 */
export async function requireStackOutputs<K extends string>(
  region: string,
  stackName: string,
  keys: readonly K[],
  redeployHint: string,
): Promise<Record<K, string>> {
  const outputs = await outputsIfDeployed(region, stackName);
  const values = Object.fromEntries(keys.map(
    (key) => [key, outputs.find((o) => o.OutputKey === key)?.OutputValue],
  ));
  const missing = keys.filter((key) => !values[key]);
  if (missing.length > 0) {
    throw new CliError(`Stack '${stackName}' is missing outputs ${missing.join(', ')}. ${redeployHint}`);
  }
  return values as Record<K, string>;
}
