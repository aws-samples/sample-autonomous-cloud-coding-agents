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

import { AssemblyCensus, AssemblyDifference, compareAssemblies } from './assembly';
import { SynthesisProfile } from './profiles';
import { requiresStatefulRetention } from '../constructs/stateful-retention';

export type WorkerResult = { kind: 'synthesized'; census: AssemblyCensus } | { kind: 'rejected'; error: string };
export type Budgets = Readonly<Record<'resources' | 'bytes' | 'parameters' | 'outputs', number>>;
export type Worker = (profile: SynthesisProfile, directory: string) => WorkerResult;

/** Leave room for the next change instead of waiting for CloudFormation's hard limit. */
export const DEFAULT_BUDGETS: Budgets = { resources: 490, bytes: 800_000, parameters: 200, outputs: 200 };

export interface ProfileAudit {
  readonly profile: SynthesisProfile;
  readonly first?: WorkerResult;
  readonly second?: WorkerResult;
  readonly differences: readonly AssemblyDifference[];
  readonly failures: readonly string[];
}

function resultFailures(profile: SynthesisProfile, result: WorkerResult, budgets: Budgets): string[] {
  if (result.kind === 'rejected') {
    return profile.expectedError && result.error.startsWith(profile.expectedError) ? [] : [result.error];
  }
  const failures = [...result.census.errors];
  if (profile.expectedError) failures.push(`Expected rejection was not raised: ${profile.expectedError}`);
  for (const template of result.census.templates) {
    for (const resource of template.inventory) {
      if (requiresStatefulRetention(resource.type)
        && (resource.deletionPolicy !== 'Retain' || resource.updateReplacePolicy !== 'Retain')) {
        failures.push(`${template.file}/${resource.logicalId}: ${resource.type} requires DeletionPolicy and UpdateReplacePolicy Retain`);
      }
    }
    for (const metric of ['resources', 'bytes', 'parameters', 'outputs'] as const) {
      if (template[metric] > budgets[metric]) {
        failures.push(`${template.file}: ${template[metric]} ${metric} exceeds ${budgets[metric]}`);
      }
    }
  }
  return failures;
}

/** Apply identical acceptance rules to both independent runs, including expected rejections. */
export function auditProfile(
  profile: SynthesisProfile,
  directory: string,
  budgets: Budgets,
  checkStability: boolean,
  worker: Worker,
): ProfileAudit {
  const failures: string[] = [];
  let first: WorkerResult | undefined;
  let second: WorkerResult | undefined;
  let differences: readonly AssemblyDifference[] = [];
  try {
    first = worker(profile, directory);
    failures.push(...resultFailures(profile, first, budgets));
    if (checkStability) {
      const repeatDirectory = `${directory}-repeat`;
      second = worker(profile, repeatDirectory);
      failures.push(...resultFailures(profile, second, budgets).map(failure => `Repeat: ${failure}`));
      if (first.kind === 'synthesized' && second.kind === 'synthesized') {
        differences = compareAssemblies(directory, repeatDirectory);
        if (differences.length) failures.push(`Unstable assembly: ${differences.map(d => `${d.file} (${d.kind})`).join(', ')}`);
      }
    }
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  return { profile, first, second, differences, failures };
}
