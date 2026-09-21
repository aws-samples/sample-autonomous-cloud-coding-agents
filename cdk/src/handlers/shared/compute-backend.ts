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

/** The deployment selects one backend; repositories inherit that selection. */
export type ComputeBackend = 'agentcore' | 'ecs' | 'lambda-microvm';

export function resolveComputeBackend(value: unknown = 'agentcore'): ComputeBackend {
  if (value === 'agentcore' || value === 'ecs' || value === 'lambda-microvm') return value;
  throw new Error(`compute_type must be agentcore, ecs or lambda-microvm; received '${String(value)}'`);
}

/** Legacy deployments without a selection retain their per-repository routing. */
export function resolveRepositoryBackend(override: unknown, deployed: string | undefined): ComputeBackend {
  const selected = resolveComputeBackend(deployed);
  const effective = resolveComputeBackend(override ?? selected);
  if (deployed !== undefined && effective !== selected) {
    throw new Error(`Repository compute_type '${effective}' is not deployed; this stack deploys only '${selected}'. Update the repository configuration before submitting tasks.`);
  }
  return effective;
}
