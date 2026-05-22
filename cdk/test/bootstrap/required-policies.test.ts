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

import { getRequiredBootstrapPolicies } from '../../src/bootstrap/required-policies';

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
});
