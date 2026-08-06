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

/**
 * Verification helpers over the bootstrap resource-action map.
 *
 * This module deliberately holds NO map data. It previously carried a second,
 * parallel copy: this directory's version had CRUD depth but no production
 * consumer, while ``../resource-action-map.ts`` was create-only and wired into
 * the live synth-coverage gate. Two maps with disjoint test suites and no shared
 * consumer drift by construction, and adding a resource type to only one of them
 * is silent. The CRUD depth was merged INTO the live map (#124); what remains
 * here are the query helpers the preflight/validation layer (#125/#126) reads it
 * through.
 */

import {
  RESOURCE_ACTION_MAP,
  actionsForResource,
  type ResourceActions,
} from '../resource-action-map';

export { RESOURCE_ACTION_MAP } from '../resource-action-map';
export type { ResourceActions, LifecyclePhase } from '../resource-action-map';

/**
 * Returns the ResourceActions entry for a given CloudFormation resource type,
 * or undefined if the type is not mapped.
 */
export function getActionsForResource(cfnType: string): ResourceActions | undefined {
  return RESOURCE_ACTION_MAP[cfnType];
}

/**
 * Returns the set of all unique IAM actions referenced across all map entries,
 * across every lifecycle phase.
 */
export function getAllMappedActions(): Set<string> {
  const actions = new Set<string>();
  for (const cfnType of Object.keys(RESOURCE_ACTION_MAP)) {
    for (const action of actionsForResource(cfnType)) {
      actions.add(action);
    }
  }
  return actions;
}
