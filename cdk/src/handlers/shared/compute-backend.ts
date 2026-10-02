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

/** A deployment selects one or more backends; the first listed is the repository default. */
export type ComputeBackend = 'agentcore' | 'ecs' | 'lambda-microvm';

export function resolveComputeBackend(value: unknown = 'agentcore'): ComputeBackend {
  if (value === 'agentcore' || value === 'ecs' || value === 'lambda-microvm') return value;
  throw new Error(`compute_type must be agentcore, ecs or lambda-microvm; received '${String(value)}'`);
}

/**
 * Resolve the deployed backends from `compute_types` (comma list or array).
 * Without it, a legacy `compute_type=ecs|lambda-microvm` keeps the additive
 * shape `main` deploys today: AgentCore (still the repository default) plus
 * that backend.
 */
export function resolveComputeBackends(computeTypes: unknown, legacyComputeType?: unknown): ComputeBackend[] {
  if (computeTypes === undefined || computeTypes === null || computeTypes === '') {
    const legacy = resolveComputeBackend(legacyComputeType ?? 'agentcore');
    return legacy === 'agentcore' ? ['agentcore'] : ['agentcore', legacy];
  }
  const raw = Array.isArray(computeTypes) ? computeTypes : String(computeTypes).split(',');
  const backends = [...new Set(raw.map(value => resolveComputeBackend(String(value).trim())))];
  if (backends.length === 0) throw new Error('compute_types must list at least one backend');
  return backends;
}

/** Legacy deployments without a selection retain their per-repository routing. */
export function resolveRepositoryBackend(override: unknown, deployed: string | undefined): ComputeBackend {
  const backends = deployed === undefined ? undefined : resolveComputeBackends(deployed);
  const effective = resolveComputeBackend(override ?? backends?.[0]);
  if (backends && !backends.includes(effective)) {
    throw new Error(`Repository compute_type '${effective}' is not deployed; this stack deploys only '${backends.join(', ')}'. Update the repository configuration before submitting tasks.`);
  }
  return effective;
}
