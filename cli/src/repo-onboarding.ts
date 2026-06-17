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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Stack-output key that exposes the name of the RepoTable — the DynamoDB
 * table the Blueprint construct writes a `status='active'` row into for
 * every onboarded repository. Mirrors the `CfnOutput` id in
 * `cdk/src/stacks/agent.ts`.
 */
export const REPO_TABLE_OUTPUT_KEY = 'RepoTableName';

/**
 * Result of checking whether a repo has a deployed Blueprint (i.e. an
 * active RepoTable row). Mirrors the runtime onboarding gate in
 * `cdk/src/handlers/shared/repo-config.ts` (`lookupRepo`):
 *
 *   - `onboarded`   — an `active` row exists; the repo will trigger.
 *   - `not-onboarded` (`missing`)  — no row at all for this `owner/repo`.
 *   - `not-onboarded` (`inactive`) — a row exists but `status != 'active'`
 *     (e.g. soft-removed); the runtime gate treats this as not onboarded.
 *   - `unverifiable` — the check could not run (RepoTable output absent, or
 *     an IAM / read error). The caller should warn and proceed rather than
 *     block on an inconclusive signal, since the misconfiguration is the
 *     check's, not the mapping's.
 */
export type RepoOnboardingResult =
  | { readonly kind: 'onboarded' }
  | { readonly kind: 'not-onboarded'; readonly reason: 'missing' | 'inactive'; readonly status?: string }
  | { readonly kind: 'unverifiable'; readonly detail: string };

export interface CheckRepoOnboardingOptions {
  readonly region: string;
  readonly stackName: string;
  /** The `owner/repo` string the operator is about to map. */
  readonly repo: string;
}

/**
 * Read a single stack output. Returns null when the stack or the output
 * does not exist, so callers can distinguish "not deployed" from a real
 * AWS error (which is rethrown).
 */
async function getStackOutput(region: string, stackName: string, outputKey: string): Promise<string | null> {
  const cfn = new CloudFormationClient({ region });
  try {
    const result = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
    const output = (result.Stacks?.[0]?.Outputs ?? []).find((o) => o.OutputKey === outputKey);
    return output?.OutputValue ?? null;
  } catch (err) {
    const name = (err as Error)?.name ?? '';
    const message = (err as Error)?.message ?? '';
    if (name === 'ValidationError' && /does not exist/i.test(message)) {
      return null;
    }
    throw err;
  }
}

/**
 * Check whether `opts.repo` is onboarded — i.e. has an `active` row in the
 * deployed RepoTable, the same condition the task-submit gate enforces at
 * trigger time (`422 REPO_NOT_ONBOARDED`). Run this at `map`/`onboard`
 * time so an operator learns immediately that a mapping can never fire,
 * rather than discovering it deep in the processor when a label is added.
 *
 * Never throws for the "not onboarded" case — that is a normal verdict the
 * caller turns into actionable guidance. A genuinely inconclusive check
 * (missing output, IAM gap) returns `unverifiable` with detail so the
 * caller can warn-and-proceed instead of falsely blocking a valid mapping.
 */
export async function checkRepoOnboarding(opts: CheckRepoOnboardingOptions): Promise<RepoOnboardingResult> {
  let repoTableName: string | null;
  try {
    repoTableName = await getStackOutput(opts.region, opts.stackName, REPO_TABLE_OUTPUT_KEY);
  } catch (err) {
    return { kind: 'unverifiable', detail: `could not read stack outputs: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!repoTableName) {
    return {
      kind: 'unverifiable',
      detail: `stack '${opts.stackName}' has no ${REPO_TABLE_OUTPUT_KEY} output (deploy the latest CDK stack to enable the onboarding check)`,
    };
  }

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }));
  let item: Record<string, unknown> | undefined;
  try {
    const result = await ddb.send(new GetCommand({
      TableName: repoTableName,
      Key: { repo: opts.repo },
    }));
    item = result.Item;
  } catch (err) {
    return { kind: 'unverifiable', detail: `could not read RepoTable '${repoTableName}': ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!item) {
    return { kind: 'not-onboarded', reason: 'missing' };
  }
  const status = typeof item.status === 'string' ? item.status : undefined;
  if (status !== 'active') {
    return { kind: 'not-onboarded', reason: 'inactive', status };
  }
  return { kind: 'onboarded' };
}

/**
 * Build the multi-line operator guidance printed when a repo is not
 * onboarded. Shared by the Jira and Linear map commands so the remediation
 * steps stay identical. `repo` is the offending `owner/repo`.
 */
export function notOnboardedGuidance(repo: string, result: Extract<RepoOnboardingResult, { kind: 'not-onboarded' }>): string[] {
  const lead = result.reason === 'inactive'
    ? `Repository '${repo}' has a RepoTable row but its status is '${result.status ?? 'unknown'}' (not 'active'), so the task-submit gate will reject every trigger with 422 REPO_NOT_ONBOARDED.`
    : `Repository '${repo}' is not onboarded — it has no active Blueprint, so the task-submit gate will reject every trigger with 422 REPO_NOT_ONBOARDED.`;
  return [
    lead,
    '',
    'Onboard the repo first by deploying a Blueprint for it, then re-run this command:',
    '',
    '  1. Add (or point) a Blueprint construct at this repo in cdk/src/stacks/agent.ts,',
    '     e.g. set BLUEPRINT_REPO / the `blueprintRepo` CDK context, or instantiate',
    `       new Blueprint(this, 'MyRepoBlueprint', { repo: '${repo}', repoTable: repoTable.table });`,
    '  2. Deploy:  MISE_EXPERIMENTAL=1 mise //cdk:deploy',
    '  3. Re-run this map command.',
    '',
    'See docs/guides/QUICK_START.md (“Onboard a repository / Blueprint”) for the full steps.',
    'To map anyway (e.g. you are deploying the Blueprint momentarily), pass --skip-onboarding-check.',
  ];
}
