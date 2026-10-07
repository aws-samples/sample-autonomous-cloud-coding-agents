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

import type { Node } from 'constructs';
import type { BlueprintProps } from '../constructs/blueprint';

/** Repository configuration before it is bound to a RepoTable or a stack. */
export interface BlueprintDefinition extends Omit<BlueprintProps, 'repoTable'> {
  /** Stable construct ID for this repository's provisioning controller. */
  readonly id: string;
}

/** Resolve once so repository provisioning and the network use the same inputs. */
export function resolveBlueprintDefinitions(
  node: Node,
  environment: NodeJS.ProcessEnv = process.env,
): readonly BlueprintDefinition[] {
  const definitions: BlueprintDefinition[] = [{
    id: 'AgentPluginsBlueprint',
    repo: environment.BLUEPRINT_REPO ?? node.tryGetContext('blueprintRepo') ?? 'awslabs/agent-plugins',
  }];
  // Optional per-repository registry assets (#246); preserve the deployed IDs
  // and environment/context precedence while moving configuration out of a stack.
  const forkRepo = environment.FORK_BLUEPRINT_REPO ?? node.tryGetContext('forkBlueprintRepo');
  if (forkRepo) {
    definitions.push({
      id: 'ForkBlueprint',
      repo: forkRepo,
      assets: {
        mcpServers: ['registry://mcp_server/acme/aws-knowledge@^1.0.0'],
        cedarPolicyModules: ['registry://cedar_policy_module/acme/guard@^1.0.0'],
        skills: ['registry://skill/acme/readme-helper@^1.0.0'],
      },
    });
  }
  return definitions;
}

/** Aggregate plain domain strings without referring to repository resources. */
export function blueprintEgressDomains(definitions: readonly BlueprintDefinition[]): string[] {
  return [...new Set(definitions.flatMap(definition => definition.networking?.egressAllowlist ?? []))];
}
