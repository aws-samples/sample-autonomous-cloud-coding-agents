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

import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cedar = require('@cedar-policy/cedar-wasm/nodejs');

const FIXTURE_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'contracts', 'cedar-parity');

const VALID_DECISIONS = new Set(['allow', 'deny']);

interface EntityRef {
  type: string;
  id: string;
}

interface Fixture {
  name: string;
  description?: string;
  policies: string;
  input: {
    principal: EntityRef;
    action: EntityRef;
    resource: EntityRef;
    context: Record<string, unknown>;
  };
  expected: {
    decision: 'allow' | 'deny';
    matching_rule_ids: string[];
  };
}

interface PolicySetParts {
  type: 'success' | 'failure';
  policies?: string[];
  errors?: unknown[];
}

interface PolicyJson {
  type: 'success' | 'failure';
  json?: {
    annotations?: Record<string, string>;
    [key: string]: unknown;
  };
}

interface IsAuthorizedResponse {
  type: 'success' | 'failure';
  response?: {
    decision: 'allow' | 'deny';
    diagnostics: {
      reason: string[];
      errors: unknown[];
    };
  };
}

function validateFixture(fixture: Fixture, filename: string): void {
  for (const required of ['name', 'policies', 'input', 'expected'] as const) {
    if (!(required in fixture)) {
      throw new Error(`${filename}: missing required field '${required}'`);
    }
  }
  for (const required of ['principal', 'action', 'resource'] as const) {
    if (!(required in fixture.input)) {
      throw new Error(`${filename}: input missing '${required}'`);
    }
  }
  if (!('decision' in fixture.expected) || !('matching_rule_ids' in fixture.expected)) {
    throw new Error(`${filename}: expected missing decision/matching_rule_ids`);
  }
  if (!VALID_DECISIONS.has(fixture.expected.decision)) {
    throw new Error(
      `${filename}: decision must be lowercase in ${JSON.stringify([...VALID_DECISIONS])}, ` +
        `got ${JSON.stringify(fixture.expected.decision)}`,
    );
  }
}

function loadFixtures(): Fixture[] {
  if (!fs.existsSync(FIXTURE_DIR) || !fs.statSync(FIXTURE_DIR).isDirectory()) {
    throw new Error(`expected fixture dir at ${FIXTURE_DIR}; see contracts/cedar-parity/README.md`);
  }
  const fixtures: Fixture[] = [];
  for (const entry of fs.readdirSync(FIXTURE_DIR).sort()) {
    if (!entry.endsWith('.json')) continue;
    const text = fs.readFileSync(path.join(FIXTURE_DIR, entry), 'utf8');
    const fixture = JSON.parse(text) as Fixture;
    validateFixture(fixture, entry);
    fixtures.push(fixture);
  }
  if (fixtures.length === 0) {
    throw new Error(`no fixtures found under ${FIXTURE_DIR}; at least one golden file is required`);
  }
  return fixtures;
}

function buildIdMap(policies: string): Record<string, string> {
  const parts = cedar.policySetTextToParts(policies) as PolicySetParts;
  if (parts.type !== 'success' || !parts.policies) {
    throw new Error(`policySetTextToParts failed: ${JSON.stringify(parts)}`);
  }
  const idMap: Record<string, string> = {};
  parts.policies.forEach((p, i) => {
    const parsed = cedar.policyToJson(p) as PolicyJson;
    if (parsed.type === 'success' && parsed.json?.annotations?.rule_id) {
      idMap[`policy${i}`] = parsed.json.annotations.rule_id;
    }
  });
  return idMap;
}

// cedar-wasm reports a matching policy by its position in the policy text (policy0, policy1, ...), not by its @rule_id.
function recoverRuleIds(policies: string, matchingPolicyIds: string[]): string[] {
  const idMap = buildIdMap(policies);
  const recovered: string[] = [];
  for (const pid of matchingPolicyIds) {
    const ruleId = idMap[pid];
    if (!ruleId) {
      throw new Error(
        `cedar-wasm matched policy '${pid}' but the fixture's policies define ` +
          'no @rule_id annotation for it; every fixture policy (including the ' +
          'base permit) must carry a rule_id so cross-engine disagreement ' +
          'surfaces rather than being silently dropped',
      );
    }
    recovered.push(ruleId);
  }
  return recovered.sort();
}

const fixtures = loadFixtures();

describe('cedar cross-engine parity (cdk side: cedar-wasm)', () => {
  test('fixture directory is present and non-empty', () => {
    expect(fs.statSync(FIXTURE_DIR).isDirectory()).toBe(true);
    expect(fixtures.length).toBeGreaterThanOrEqual(1);
  });

  test.each<Fixture>(fixtures)(
    'cedar-wasm matches fixture: $name',
    (fixture) => {
      const result = cedar.isAuthorized({
        principal: fixture.input.principal,
        action: fixture.input.action,
        resource: fixture.input.resource,
        context: fixture.input.context,
        policies: { staticPolicies: fixture.policies },
        entities: [],
      }) as IsAuthorizedResponse;

      expect(result.type).toBe('success');
      expect(result.response).toBeDefined();

      const observedDecision = result.response!.decision;
      expect(observedDecision).toBe(fixture.expected.decision);

      const observedRuleIds = recoverRuleIds(
        fixture.policies,
        result.response!.diagnostics.reason || [],
      );
      const expectedRuleIds = [...fixture.expected.matching_rule_ids].sort();
      expect(observedRuleIds).toEqual(expectedRuleIds);
    },
  );
});
