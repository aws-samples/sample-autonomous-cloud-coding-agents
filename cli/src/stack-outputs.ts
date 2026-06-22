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
  const cf = new CloudFormationClient({ region });
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

/** CloudFormation output keys written by `bgagent configure`. */
export const CONFIGURE_STACK_OUTPUT_KEYS = ['ApiUrl', 'UserPoolId', 'AppClientId'] as const;

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
  const userPoolId = byKey.get('UserPoolId');
  const appClientId = byKey.get('AppClientId');
  if (!apiUrl || !userPoolId || !appClientId) {
    return null;
  }
  return {
    api_url: apiUrl,
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
  const missing = CONFIGURE_STACK_OUTPUT_KEYS.filter((key) => !byKey.get(key));
  throw new CliError(
    `Stack '${stackName}' is missing configure outputs in ${region}: ${missing.join(', ')}. `
    + 'Deploy the stack or pass --api-url / --user-pool-id / --client-id explicitly.',
  );
}

/** Read a single CloudFormation stack output by key. */
export async function getStackOutput(
  region: string,
  stackName: string,
  outputKey: string,
): Promise<string | null> {
  const stack = await describeStack(region, stackName);
  return stack.Outputs?.find((o) => o.OutputKey === outputKey)?.OutputValue ?? null;
}
