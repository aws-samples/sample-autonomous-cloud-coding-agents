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

import { componentForPath, stripAnsi } from './setup-ui';

/** Resource types whose deletion, replacement or orphaning loses data, installations or ownership. */
const STATE_BEARING_TYPES: ReadonlyMap<string, string> = new Map([
  ['AWS::DynamoDB::Table', 'table'],
  ['AWS::DynamoDB::GlobalTable', 'table'],
  ['AWS::SecretsManager::Secret', 'secret'],
  ['AWS::S3::Bucket', 'bucket'],
  ['AWS::Cognito::UserPool', 'user pool'],
  ['AWS::KMS::Key', 'encryption key'],
  ['AWS::Logs::LogGroup', 'log group'],
  ['AWS::CloudFormation::Stack', 'nested stack'],
  ['AWS::BedrockAgentCore::Memory', 'agent memory'],
  ['AWS::EC2::VPC', 'VPC'],
]);

export interface StateBearingChange {
  readonly change: 'delete' | 'replace' | 'orphan';
  readonly type: string;
  /** Construct path when CDK prints one, else the logical ID. */
  readonly id: string;
}

/**
 * State-bearing deletions, replacements and orphanings in `cdk diff` output.
 * CDK ends each resource line with its impact (`destroy`, `orphan`, `replace`,
 * `may be replaced`); `(requires replacement)` appears only on property lines.
 */
export function parseStateBearingChanges(diffOutput: string): StateBearingChange[] {
  const changes: StateBearingChange[] = [];
  for (const raw of stripAnsi(diffOutput).split('\n')) {
    const match = /^\s*\[([-~])\]\s+(\S+)\s+(\S+)(.*)$/.exec(raw);
    if (!match || !STATE_BEARING_TYPES.has(match[2])) continue;
    const [, marker, type, id, impact] = match;
    if (marker === '-') changes.push({ change: /\borphan\b/.test(impact) ? 'orphan' : 'delete', type, id });
    else if (/\b(replace|may be replaced)\s*$/.test(impact)) changes.push({ change: 'replace', type, id });
  }
  return changes;
}

/** "Slack: 3 tables, 1 secret" from state-bearing changes, grouped by component. */
export function describeDataLoss(changes: readonly StateBearingChange[], stackNames: readonly string[]): string[] {
  const byComponent = new Map<string, Map<string, number>>();
  for (const change of changes) {
    const component = componentForPath(change.id, stackNames);
    const nouns = byComponent.get(component) ?? new Map<string, number>();
    const noun = STATE_BEARING_TYPES.get(change.type)!;
    nouns.set(noun, (nouns.get(noun) ?? 0) + 1);
    byComponent.set(component, nouns);
  }
  return [...byComponent].map(([component, nouns]) => `${component}: ${[...nouns]
    .map(([noun, count]) => `${count} ${noun}${count === 1 ? '' : 's'}`).join(', ')}`);
}
