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

import { App } from 'aws-cdk-lib';
import { BlueprintDefinition, blueprintEgressDomains, resolveBlueprintDefinitions } from '../../src/blueprints/definitions';

describe('Blueprint configuration before stack construction', () => {
  test('preserves the default repository and provisioning construct ID', () => {
    expect(resolveBlueprintDefinitions(new App().node, {})).toEqual([
      { id: 'AgentPluginsBlueprint', repo: 'awslabs/agent-plugins' },
    ]);
  });

  test('preserves context repositories and the fork registry assets', () => {
    const app = new App({ context: { blueprintRepo: 'example/plugins', forkBlueprintRepo: 'example/fork' } });
    expect(resolveBlueprintDefinitions(app.node, {})).toEqual([
      { id: 'AgentPluginsBlueprint', repo: 'example/plugins' },
      {
        id: 'ForkBlueprint',
        repo: 'example/fork',
        assets: {
          mcpServers: ['registry://mcp_server/acme/aws-knowledge@^1.0.0'],
          cedarPolicyModules: ['registry://cedar_policy_module/acme/guard@^1.0.0'],
          skills: ['registry://skill/acme/readme-helper@^1.0.0'],
        },
      },
    ]);
  });

  test('keeps environment precedence, including an explicit empty fork override', () => {
    const node = new App({ context: { blueprintRepo: 'context/plugins', forkBlueprintRepo: 'context/fork' } }).node;
    expect(resolveBlueprintDefinitions(node, { BLUEPRINT_REPO: 'env/plugins', FORK_BLUEPRINT_REPO: 'env/fork' })
      .map(definition => definition.repo)).toEqual(['env/plugins', 'env/fork']);
    expect(resolveBlueprintDefinitions(node, { FORK_BLUEPRINT_REPO: '' })).toEqual([
      { id: 'AgentPluginsBlueprint', repo: 'context/plugins' },
    ]);
  });

  test('creates independent definitions for each app', () => {
    const node = new App({ context: { forkBlueprintRepo: 'example/fork' } }).node;
    const first = resolveBlueprintDefinitions(node, {});
    first[1].assets!.skills!.push('registry://skill/example/custom@^1.0.0');
    expect(resolveBlueprintDefinitions(node, {})[1].assets!.skills).toEqual(['registry://skill/acme/readme-helper@^1.0.0']);
  });

  test('unions domains without mutating repository configuration or constructing resources', () => {
    const definitions: BlueprintDefinition[] = [
      { id: 'First', repo: 'example/first', networking: { egressAllowlist: ['one.example.com', '*.example.org'] } },
      { id: 'Second', repo: 'example/second', networking: { egressAllowlist: ['one.example.com', 'two.example.com'] } },
      { id: 'Third', repo: 'example/third' },
    ];
    const before = structuredClone(definitions);
    const domains = blueprintEgressDomains(definitions);
    expect(domains).toEqual(['one.example.com', '*.example.org', 'two.example.com']);
    domains.push('new.example.com');
    expect(definitions).toEqual(before);
    expect(blueprintEgressDomains([])).toEqual([]);
  });
});
