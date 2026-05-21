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

import { Stack } from 'aws-cdk-lib';

import { allPolicies } from '../../src/bootstrap/policies';
import {
  RESOURCE_ACTION_MAP,
  getActionsForResource,
  getAllMappedActions,
} from '../../src/bootstrap/preflight';

/**
 * Extracts all actions from the combined bootstrap policies.
 * Returns a set of individual actions PLUS any wildcard prefixes
 * (e.g. 'bedrock-agentcore:*' → prefix 'bedrock-agentcore:').
 */
function extractPolicyActions(): { actions: Set<string>; wildcardPrefixes: Set<string> } {
  const actions = new Set<string>();
  const wildcardPrefixes = new Set<string>();
  const stack = new Stack();

  for (const policyDoc of allPolicies()) {
    // Resolve the policy document to get the raw JSON
    const resolved = stack.resolve(policyDoc.toJSON());
    for (const statement of resolved.Statement ?? []) {
      if (statement.Effect !== 'Allow') continue;
      const stmtActions = Array.isArray(statement.Action)
        ? statement.Action
        : [statement.Action];
      for (const action of stmtActions) {
        if (action.endsWith(':*')) {
          // Wildcard: extract the service prefix (e.g. 'bedrock-agentcore:*' → 'bedrock-agentcore:')
          wildcardPrefixes.add(action.slice(0, action.lastIndexOf('*')));
        }
        actions.add(action);
      }
    }
  }
  return { actions, wildcardPrefixes };
}

/**
 * Services with known policy gaps. Actions from these services are excluded
 * from the policy coverage assertion, to be addressed in follow-up policy updates.
 */
const KNOWN_GAP_SERVICES = new Set([
  'sqs', // SQS actions not yet in bootstrap policies
  's3', // S3 bucket lifecycle actions (CreateBucket, etc.) beyond CDK asset access
]);

/**
 * Individual actions not yet in policies but required for specific resource types.
 * These are known gaps to be addressed in follow-up policy updates.
 */
const KNOWN_GAP_ACTIONS = new Set([
  // Lambda EventSourceMapping actions not in current policies
  'lambda:CreateEventSourceMapping',
  'lambda:GetEventSourceMapping',
  'lambda:UpdateEventSourceMapping',
  'lambda:DeleteEventSourceMapping',
  // Lambda LayerVersion actions not in current policies
  'lambda:PublishLayerVersion',
  'lambda:GetLayerVersion',
  'lambda:DeleteLayerVersion',
]);

describe('resource-action-map', () => {
  describe('map structure', () => {
    it('has entries for at least 55 resource types', () => {
      const entryCount = Object.keys(RESOURCE_ACTION_MAP).length;
      expect(entryCount).toBeGreaterThanOrEqual(55);
    });

    it('every entry has at least one action in create or delete', () => {
      for (const [type, entry] of Object.entries(RESOURCE_ACTION_MAP)) {
        const hasCreateOrDelete = entry.create.length > 0 || entry.delete.length > 0;
        expect(hasCreateOrDelete).toBe(true);
        if (!hasCreateOrDelete) {
          // Extra info for debugging (won't reach here if assertion passes)
          throw new Error(`${type} has no create or delete actions`);
        }
      }
    });

    it('all actions use valid IAM format (service:ActionName) or wildcard (service:*)', () => {
      // Standard format: lowercase-service-with-hyphens : PascalCaseAction
      const validFormat = /^[a-z][a-z0-9-]*:[A-Z][A-Za-z0-9]*$/;
      // Wildcard format: service:*
      const wildcardFormat = /^[a-z][a-z0-9-]*:\*$/;
      // API Gateway uses HTTP verbs (uppercase) as actions
      const apiGatewayFormat = /^apigateway:(GET|PUT|POST|PATCH|DELETE)$/;

      for (const [type, entry] of Object.entries(RESOURCE_ACTION_MAP)) {
        const allActions = [...entry.create, ...entry.read, ...entry.update, ...entry.delete];
        for (const action of allActions) {
          const isValid = validFormat.test(action) || wildcardFormat.test(action) || apiGatewayFormat.test(action);
          if (!isValid) {
            throw new Error(`Invalid action format '${action}' in ${type}`);
          }
          expect(isValid).toBe(true);
        }
      }
    });
  });

  describe('policy coverage', () => {
    it('all mapped actions (excluding known gaps) exist in the combined policy set', () => {
      const { actions: policyActions, wildcardPrefixes } = extractPolicyActions();
      const mappedActions = getAllMappedActions();
      const uncovered: string[] = [];

      for (const action of mappedActions) {
        // Skip known-gap services
        const service = action.split(':')[0];
        if (KNOWN_GAP_SERVICES.has(service)) continue;

        // Skip known-gap individual actions
        if (KNOWN_GAP_ACTIONS.has(action)) continue;

        // Check direct match
        if (policyActions.has(action)) continue;

        // Check wildcard coverage (e.g. bedrock-agentcore:* covers bedrock-agentcore:CreateMemory)
        const actionPrefix = service + ':';
        if (wildcardPrefixes.has(actionPrefix)) continue;

        uncovered.push(action);
      }

      if (uncovered.length > 0) {
        throw new Error(
          `${uncovered.length} actions not covered by bootstrap policies:\n  ${uncovered.join('\n  ')}`,
        );
      }
      expect(uncovered).toHaveLength(0);
    });
  });

  describe('getActionsForResource', () => {
    it('returns actions for a known resource type', () => {
      const result = getActionsForResource('AWS::Lambda::Function');
      expect(result).toBeDefined();
      expect(result!.create).toContain('lambda:CreateFunction');
      expect(result!.delete).toContain('lambda:DeleteFunction');
    });

    it('returns undefined for an unknown resource type', () => {
      const result = getActionsForResource('AWS::Nonexistent::Resource');
      expect(result).toBeUndefined();
    });
  });

  describe('getAllMappedActions', () => {
    it('returns a non-empty Set', () => {
      const actions = getAllMappedActions();
      expect(actions.size).toBeGreaterThan(0);
    });

    it('contains actions from multiple services', () => {
      const actions = getAllMappedActions();
      const services = new Set<string>();
      for (const action of actions) {
        services.add(action.split(':')[0]);
      }
      // Should cover at least 10 distinct services
      expect(services.size).toBeGreaterThanOrEqual(10);
    });
  });
});
