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

import { policiesForComputeType } from '../../src/bootstrap/policies';
import { getRequiredBootstrapPolicies } from '../../src/bootstrap/required-policies';
import { collectBootstrapAllowActions } from '../../src/bootstrap/resource-action-map';

describe('getRequiredBootstrapPolicies', () => {
  it('returns core policies plus compute-agentcore for agentcore type', () => {
    const result = getRequiredBootstrapPolicies('agentcore');
    expect(result).toEqual(['infrastructure', 'application', 'observability', 'compute-agentcore']);
  });

  it('returns core policies plus compute-ecs for ecs type', () => {
    const result = getRequiredBootstrapPolicies('ecs');
    expect(result).toEqual(['infrastructure', 'application', 'observability', 'compute-ecs']);
    expect(result).not.toContain('compute-agentcore');
  });

  it('compute variants are independent choices', () => {
    const agentcore = getRequiredBootstrapPolicies('agentcore');
    const ecs = getRequiredBootstrapPolicies('ecs');
    expect(agentcore).toContain('compute-agentcore');
    expect(agentcore).not.toContain('compute-ecs');
    expect(ecs).toContain('compute-ecs');
    expect(ecs).not.toContain('compute-agentcore');
  });

  it('returns only core policies for unknown compute type', () => {
    const result = getRequiredBootstrapPolicies('unknown');
    expect(result).toEqual(['infrastructure', 'application', 'observability']);
    expect(result).not.toContain('compute-ecs');
    expect(result).not.toContain('compute-agentcore');
  });

  it('every selected name resolves to a real policy document', () => {
    // Guards the drift this indirection exists to prevent: a name here with no
    // document in policies/index.ts would silently under-scope validation.
    for (const computeType of ['agentcore', 'ecs']) {
      expect(() => policiesForComputeType(computeType)).not.toThrow();
      expect(policiesForComputeType(computeType)).toHaveLength(
        getRequiredBootstrapPolicies(computeType).length,
      );
    }
  });
});

describe('collectBootstrapAllowActions scoping (RFC #120 `deployed ⊇ required`)', () => {
  it('excludes ecs:* for an agentcore-only operator', () => {
    // The defect this closes: validating against the UNION accepts actions the
    // operator's real IaCRole cannot perform, because they never deployed
    // compute-ecs. That is the over-permissive direction the map exists to catch.
    const agentcore = collectBootstrapAllowActions('agentcore');
    expect([...agentcore].filter((a) => a.startsWith('ecs:'))).toEqual([]);
  });

  it('includes ecs:* only under the ecs substrate, and drops agentcore-only grants', () => {
    const ecs = collectBootstrapAllowActions('ecs');
    expect([...ecs].filter((a) => a.startsWith('ecs:')).length).toBeGreaterThan(0);
    expect([...ecs].filter((a) => a.startsWith('bedrock-agentcore:'))).toEqual([]);
  });

  it('each scoped set is a strict subset of the union', () => {
    const union = collectBootstrapAllowActions();
    for (const computeType of ['agentcore', 'ecs']) {
      const scoped = collectBootstrapAllowActions(computeType);
      for (const action of scoped) {
        expect(union).toContain(action);
      }
      expect(scoped.size).toBeLessThan(union.size);
    }
  });

  it('omitting the compute type preserves the historical union', () => {
    const union = collectBootstrapAllowActions();
    expect([...union].filter((a) => a.startsWith('ecs:')).length).toBeGreaterThan(0);
    expect([...union].filter((a) => a.startsWith('bedrock-agentcore:')).length)
      .toBeGreaterThan(0);
  });
});
