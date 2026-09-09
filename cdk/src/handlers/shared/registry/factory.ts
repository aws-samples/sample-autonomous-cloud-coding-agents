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

// Single place handlers obtain a `RegistryClient`. Keeping the concrete adapter
// choice here (not in each handler) means the substrate swap touches one file.

import { AgentRegistryClient } from './agent-registry-client';
import type { RegistryClient } from './client';

/** Cognito group names that gate publish / approval (#246, REGISTRY.md §10). */
export const REGISTRY_PUBLISHER_GROUP = 'RegistryPublisher';
export const REGISTRY_APPROVER_GROUP = 'RegistryApprover';

/** Build the registry client from the handler's environment. */
export function makeRegistryClient(): RegistryClient {
  const registryId = process.env.AGENT_REGISTRY_ID;
  if (!registryId) {
    throw new Error(
      'Agent Registry is disabled or not configured (AGENT_REGISTRY_ID is not set); '
      + 'remove registry:// refs or deploy with enableAgentRegistry=true',
    );
  }
  return new AgentRegistryClient({ registryId });
}
