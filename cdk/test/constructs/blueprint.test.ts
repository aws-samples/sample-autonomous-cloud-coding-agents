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

import { App, Lazy, Stack } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Blueprint, type BlueprintProps } from '../../src/constructs/blueprint';
import { MAX_BUDGET_USD_MAX, MAX_BUDGET_USD_MIN } from '../../src/handlers/shared/types';

function createStack(
  props?: Partial<BlueprintProps>,
  context?: Record<string, unknown>,
): { stack: Stack; template: Template } {
  const app = new App({ context });
  const stack = new Stack(app, 'TestStack');

  const repoTable = new dynamodb.Table(stack, 'RepoTable', {
    partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
  });

  new Blueprint(stack, 'Blueprint', {
    repo: 'org/my-repo',
    repoTable,
    ...props,
  });

  const template = Template.fromStack(stack);
  return { stack, template };
}

/**
 * Extract the serialized Fn::Join string parts from the Custom::AWS Update property.
 * AwsCustomResource serializes parameters as Fn::Join when CDK tokens are present.
 */
function getUpdateJoinParts(template: Template): string[] {
  const resources = template.findResources('Custom::AWS');
  const resourceKey = Object.keys(resources)[0];
  const update = (resources[resourceKey] as any).Properties.Update;
  if (update && update['Fn::Join']) {
    return update['Fn::Join'][1].filter((part: unknown) => typeof part === 'string');
  }
  return [];
}

/** The Update call, parsed, with 'table-name' where the Fn::Join holds the table's reference. */
function updateCall(template: Template): {
  parameters: {
    UpdateExpression: string;
    ExpressionAttributeNames: Record<string, string>;
    ExpressionAttributeValues: Record<string, unknown>;
  };
} {
  const update = Object.values(template.findResources('Custom::AWS'))[0].Properties.Update;
  const serialized = typeof update === 'string' ? update
    : update['Fn::Join'][1].map((part: unknown) => typeof part === 'string' ? part : 'table-name').join('');
  return JSON.parse(serialized);
}

function getDeleteJoinParts(template: Template): string[] {
  const resources = template.findResources('Custom::AWS');
  const resourceKey = Object.keys(resources)[0];
  const del = (resources[resourceKey] as any).Properties.Delete;
  if (del && del['Fn::Join']) {
    return del['Fn::Join'][1].filter((part: unknown) => typeof part === 'string');
  }
  return [];
}

describe('Blueprint construct', () => {
  test('creates a Custom::AWS resource', () => {
    const { template } = createStack();
    template.resourceCountIs('Custom::AWS', 1);
  });

  test('Properties.Create equals Properties.Update', () => {
    const { Create, Update } = Object.values(createStack().template.findResources('Custom::AWS'))[0].Properties;
    expect(Create).toEqual(Update);
  });

  test('onDelete uses DynamoDB updateItem with status removed', () => {
    const { template } = createStack();
    const parts = getDeleteJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('"service":"DynamoDB"');
    expect(serialized).toContain('"action":"updateItem"');
    expect(serialized).toContain(':removed');
    expect(serialized).toContain('"S":"removed"');
  });

  test('maps compute type prop', () => {
    const { template } = createStack({
      compute: { type: 'ecs' },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":compute_type":{"S":"ecs"}');
  });

  test('maps runtime ARN prop', () => {
    const { template } = createStack({
      compute: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/custom' },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":runtime_arn":{"S":"arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/custom"}');
  });

  test('maps agent model ID prop', () => {
    const { template } = createStack({
      agent: { modelId: 'us.anthropic.claude-sonnet-4-6' },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":model_id":{"S":"us.anthropic.claude-sonnet-4-6"}');
  });

  test('maps agent max turns prop', () => {
    const { template } = createStack({
      agent: { maxTurns: 50 },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":max_turns":{"N":"50"}');
  });

  // --- #748: agent.maxBudgetUsd (mirrors agent.maxTurns) ------------------

  test('maps agent max budget prop', () => {
    const { template } = createStack({
      agent: { maxBudgetUsd: 25 },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":max_budget_usd":{"N":"25"}');
  });

  test('maps a fractional agent max budget prop without rounding', () => {
    const { template } = createStack({
      agent: { maxBudgetUsd: 2.5 },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":max_budget_usd":{"N":"2.5"}');
  });

  test('omits max_budget_usd when agent is absent', () => {
    const { template } = createStack();
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('max_budget_usd');
  });

  test('omits max_budget_usd when maxBudgetUsd is undefined', () => {
    const { template } = createStack({
      agent: { maxTurns: 50 },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('max_budget_usd');
  });

  test('maps agent memory token budget prop', () => {
    const { template } = createStack({
      agent: { memoryTokenBudget: 4000 },
    });
    const serialized = getUpdateJoinParts(template).join('');
    expect(serialized).toContain('":memory_token_budget":{"N":"4000"}');
  });

  test('omits memory_token_budget when memoryTokenBudget is undefined', () => {
    const { template } = createStack({
      agent: { maxBudgetUsd: 5 },
    });
    expect(getUpdateJoinParts(template).join('')).not.toContain('memory_token_budget');
  });

  test('maps system prompt overrides prop', () => {
    const { template } = createStack({
      agent: { systemPromptOverrides: 'Always use TypeScript.' },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":system_prompt_overrides":{"S":"Always use TypeScript."}');
  });

  test('maps github token secret ARN prop', () => {
    const { template } = createStack({
      credentials: { githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:token' },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":github_token_secret_arn":{"S":"arn:aws:secretsmanager:us-east-1:123:secret:token"}');
  });

  test('maps build and lint command props', () => {
    const { template } = createStack({
      pipeline: { buildCommand: 'npm run build', lintCommand: 'npm run lint' },
    });
    expect(updateCall(template).parameters.ExpressionAttributeValues).toMatchObject({
      ':build_command': { S: 'npm run build' },
      ':lint_command': { S: 'npm run lint' },
    });
  });

  test('maps poll interval prop', () => {
    const { template } = createStack({
      pipeline: { pollIntervalMs: 15000 },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":poll_interval_ms":{"N":"15000"}');
  });

  test('maps networking egress allowlist to DynamoDB list', () => {
    const { template } = createStack({
      networking: { egressAllowlist: ['npm.internal.example.com', '*.private-registry.io'] },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":egress_allowlist":{"L":[{"S":"npm.internal.example.com"},{"S":"*.private-registry.io"}]}');
  });

  test('omits egress_allowlist when networking is absent', () => {
    const { template } = createStack();
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('egress_allowlist');
  });

  test('omits egress_allowlist when egressAllowlist is empty', () => {
    const { template } = createStack({
      networking: { egressAllowlist: [] },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('egress_allowlist');
  });

  test('maps security cedar policies to DynamoDB list', () => {
    const { template } = createStack({
      security: { cedarPolicies: ['forbid (principal, action, resource) when { resource == Agent::Tool::"Bash" };'] },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":cedar_policies":{"L":[{"S":"forbid (principal, action, resource) when { resource == Agent::Tool::\\"Bash\\" };"}]}');
  });

  test('omits cedar_policies when security is absent', () => {
    const { template } = createStack();
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('cedar_policies');
  });

  test('omits cedar_policies when cedarPolicies is empty', () => {
    const { template } = createStack({
      security: { cedarPolicies: [] },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('cedar_policies');
  });

  // --- Registry asset refs (#246) ---

  test('maps registry asset refs to DynamoDB lists', () => {
    const { template } = createStack({
      assets: {
        mcpServers: ['registry://mcp_server/acme/pdf-tools@^1.4.1'],
        cedarPolicyModules: ['registry://cedar_policy_module/acme/force-push@~2.0.0'],
        skills: ['registry://skill/acme/research@1.0.0'],
      },
    });
    const serialized = getUpdateJoinParts(template).join('');
    expect(serialized).toContain('":mcp_servers":{"L":[{"S":"registry://mcp_server/acme/pdf-tools@^1.4.1"}]}');
    expect(serialized).toContain('":cedar_policy_modules":{"L":[{"S":"registry://cedar_policy_module/acme/force-push@~2.0.0"}]}');
    expect(serialized).toContain('":skills":{"L":[{"S":"registry://skill/acme/research@1.0.0"}]}');
    expect(updateCall(template).parameters.UpdateExpression).toMatch(/ REMOVE #ttl$/);
  });

  test('sets no asset column when no assets are pinned', () => {
    const serialized = getUpdateJoinParts(createStack().template).join('');
    expect(serialized).not.toContain(':mcp_servers');
    expect(serialized).not.toContain(':cedar_policy_modules');
    expect(serialized).not.toContain(':skills');
  });

  test('onUpdate does NOT remove model_id — the CLI is a sanctioned co-writer of it', () => {
    // Regression guard for a fix that was WRONG. Clearing `model_id` when a Blueprint
    // declares none looked symmetric with the asset refs, but onUpdate runs on every
    // deploy (its parameters embed a synth-time timestamp) and `bgagent repo onboard
    // --model` deliberately carries the value forward (ADR-017 sanctions both writers).
    // The clear therefore deleted an operator's CLI pin on every unrelated redeploy,
    // while the troubleshooting guide prescribes that pin as the fix for a wrong model.
    const noModel = /REMOVE ([^"\\]*)/.exec(getUpdateJoinParts(createStack().template).join(''))?.[1] ?? '';
    expect(noModel).not.toContain('#model_id');

    // And a declared override is still written, not merely left alone.
    const withModel = getUpdateJoinParts(
      createStack({ agent: { modelId: 'us.anthropic.claude-opus-5' } }).template,
    ).join('');
    expect(withModel).toContain('#model_id = :model_id');
  });

  test('onUpdate REMOVEs asset columns that are now empty (detach on redeploy)', () => {
    // Only mcpServers pinned: cedar_policy_modules + skills must be REMOVEd so a
    // redeploy that cleared them detaches the stale DDB refs (#246).
    const { template } = createStack({
      assets: { mcpServers: ['registry://mcp_server/acme/pdf-tools@^1.4.1'] },
    });
    expect(updateCall(template).parameters.UpdateExpression).toBe(
      'SET #status = :active, #updated_at = :now, #onboarded_at = if_not_exists(#onboarded_at, :now), #mcp_servers = :mcp_servers'
      + ' REMOVE #ttl, #cedar_policy_modules, #skills',
    );
  });

  test('onUpdate REMOVEs all three asset columns when none are pinned', () => {
    const { template } = createStack();
    const serialized = getUpdateJoinParts(template).join('');
    expect(serialized).toContain('REMOVE #ttl, #mcp_servers, #cedar_policy_modules, #skills');
  });

  test('rejects a floating asset ref at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });
    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      assets: { mcpServers: ['registry://mcp_server/acme/pdf-tools'] },
    });
    expect(() => Template.fromStack(stack)).toThrow(/Invalid assets.mcpServers ref.*INVALID_REGISTRY_REF/);
  });

  test('rejects a malformed constraint on a skill ref at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });
    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      assets: { skills: ['registry://skill/acme/research@latest'] },
    });
    expect(() => Template.fromStack(stack)).toThrow(/Invalid assets.skills ref.*INVALID_CONSTRAINT/);
  });

  test('rejects a ref whose kind does not match its field at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });
    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      // A well-formed skill ref, but pinned under mcpServers — must be rejected
      // so a field typo can't silently activate a different asset class.
      assets: { mcpServers: ['registry://skill/acme/research@1.0.0'] },
    });
    expect(() => Template.fromStack(stack)).toThrow(
      /Wrong kind for assets.mcpServers ref.*expected a 'mcp_server' ref but got 'skill'/,
    );
  });

  // --- Chunk 7b: security.approvalGateCap ---------------------------------

  test('maps approval gate cap prop', () => {
    const { template } = createStack({
      security: { approvalGateCap: 25 },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).toContain('":approval_gate_cap":{"N":"25"}');
  });

  test('omits approval_gate_cap when security is absent', () => {
    const { template } = createStack();
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('approval_gate_cap');
  });

  test('omits approval_gate_cap when approvalGateCap is undefined', () => {
    const { template } = createStack({
      security: { cedarPolicies: ['permit (principal, action, resource);'] },
    });
    const parts = getUpdateJoinParts(template);
    const serialized = parts.join('');
    expect(serialized).not.toContain('approval_gate_cap');
  });

  test('rejects approvalGateCap below minimum at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      security: { approvalGateCap: 0 },
    });

    expect(() => Template.fromStack(stack)).toThrow(/Invalid security.approvalGateCap: 0.*between 1 and 500/);
  });

  test('rejects approvalGateCap above maximum at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      security: { approvalGateCap: 501 },
    });

    expect(() => Template.fromStack(stack)).toThrow(/Invalid security.approvalGateCap: 501.*between 1 and 500/);
  });

  test('rejects non-integer approvalGateCap at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      security: { approvalGateCap: 3.14 },
    });

    expect(() => Template.fromStack(stack)).toThrow(/Invalid security.approvalGateCap: 3.14.*integer/);
  });

  // --- #748: agent.maxBudgetUsd bounds must match the CLI's 0.01–100 ------

  test('rejects maxBudgetUsd below minimum at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      agent: { maxBudgetUsd: 0 },
    });

    expect(() => Template.fromStack(stack)).toThrow(/Invalid agent.maxBudgetUsd: 0.*between 0.01 and 100/);
  });

  test('rejects maxBudgetUsd above maximum at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      agent: { maxBudgetUsd: 100.01 },
    });

    expect(() => Template.fromStack(stack)).toThrow(/Invalid agent.maxBudgetUsd: 100.01.*between 0.01 and 100/);
  });

  test('rejects a non-finite maxBudgetUsd at synth', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      agent: { maxBudgetUsd: Number.NaN },
    });

    expect(() => Template.fromStack(stack)).toThrow(/Invalid agent.maxBudgetUsd: NaN.*finite number/);
  });

  test('accepts maxBudgetUsd boundary values matching the CLI range', () => {
    const appMin = new App();
    const stackMin = new Stack(appMin, 'TestStackMin');
    const tableMin = new dynamodb.Table(stackMin, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });
    new Blueprint(stackMin, 'Blueprint', {
      repo: 'org/min',
      repoTable: tableMin,
      agent: { maxBudgetUsd: MAX_BUDGET_USD_MIN },
    });
    expect(() => Template.fromStack(stackMin)).not.toThrow();

    const appMax = new App();
    const stackMax = new Stack(appMax, 'TestStackMax');
    const tableMax = new dynamodb.Table(stackMax, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });
    new Blueprint(stackMax, 'Blueprint', {
      repo: 'org/max',
      repoTable: tableMax,
      agent: { maxBudgetUsd: MAX_BUDGET_USD_MAX },
    });
    expect(() => Template.fromStack(stackMax)).not.toThrow();
  });

  test('blueprint bounds are the SAME constants the task-submit path validates against', () => {
    // #748 — the whole point of the prop is that a per-repo default and a
    // per-task override cannot disagree about what is in range. Both must read
    // ``contracts/constants.json``, not two hand-copied literals.
    expect(MAX_BUDGET_USD_MIN).toBe(0.01);
    expect(MAX_BUDGET_USD_MAX).toBe(100);
  });

  // 2 ** 53 is the first integer the orchestrator would read back from the row as a BigInt.
  test.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('rejects memoryTokenBudget %p at synth', (budget) => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'org/my-repo',
      repoTable,
      agent: { memoryTokenBudget: budget },
    });

    expect(() => Template.fromStack(stack)).toThrow(`Invalid agent.memoryTokenBudget: ${budget}. Must be an integer between 1 and ${Number.MAX_SAFE_INTEGER}.`);
  });

  test.each([
    [1, '1'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
  ])('accepts memoryTokenBudget %p', (budget, written) => {
    const { template } = createStack({
      agent: { memoryTokenBudget: budget },
    });
    expect(getUpdateJoinParts(template).join('')).toContain(`":memory_token_budget":{"N":"${written}"}`);
  });

  test('accepts boundary values (min and max)', () => {
    const appMin = new App();
    const stackMin = new Stack(appMin, 'TestStackMin');
    const tableMin = new dynamodb.Table(stackMin, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });
    new Blueprint(stackMin, 'Blueprint', {
      repo: 'org/min',
      repoTable: tableMin,
      security: { approvalGateCap: 1 },
    });
    expect(() => Template.fromStack(stackMin)).not.toThrow();

    const appMax = new App();
    const stackMax = new Stack(appMax, 'TestStackMax');
    const tableMax = new dynamodb.Table(stackMax, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });
    new Blueprint(stackMax, 'Blueprint', {
      repo: 'org/max',
      repoTable: tableMax,
      security: { approvalGateCap: 500 },
    });
    expect(() => Template.fromStack(stackMax)).not.toThrow();
  });

  test('a Blueprint with no override activates the row, keeps onboarded_at and removes ttl and the asset lists', () => {
    expect(updateCall(createStack().template)).toEqual({
      service: 'DynamoDB',
      action: 'updateItem',
      parameters: {
        TableName: 'table-name',
        Key: { repo: { S: 'org/my-repo' } },
        UpdateExpression: 'SET #status = :active, #updated_at = :now, #onboarded_at = if_not_exists(#onboarded_at, :now)'
          + ' REMOVE #ttl, #mcp_servers, #cedar_policy_modules, #skills',
        ExpressionAttributeNames: {
          '#status': 'status',
          '#updated_at': 'updated_at',
          '#onboarded_at': 'onboarded_at',
          '#ttl': 'ttl',
          '#mcp_servers': 'mcp_servers',
          '#cedar_policy_modules': 'cedar_policy_modules',
          '#skills': 'skills',
        },
        ExpressionAttributeValues: { ':active': { S: 'active' }, ':now': { S: expect.any(String) } },
      },
      // Under another id CloudFormation deletes the old resource, and that delete marks the row removed.
      physicalResourceId: { id: 'blueprint-org/my-repo' },
    });
  });

  // DynamoDB refuses a call that uses a placeholder it does not declare, or declares one it does not use.
  test.each<[string[], Partial<BlueprintProps>]>([
    [[], {}],
    [['compute_type'], { compute: { type: 'ecs' } }],
    [['runtime_arn'], { compute: { runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789:runtime/custom' } }],
    [['model_id'], { agent: { modelId: 'us.anthropic.claude-sonnet-4-6' } }],
    [['max_turns'], { agent: { maxTurns: 50 } }],
    [['max_budget_usd'], { agent: { maxBudgetUsd: 25 } }],
    [['memory_token_budget'], { agent: { memoryTokenBudget: 4000 } }],
    [['system_prompt_overrides'], { agent: { systemPromptOverrides: 'Always use TypeScript.' } }],
    [['github_token_secret_arn'], { credentials: { githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:token' } }],
    [['poll_interval_ms'], { pipeline: { pollIntervalMs: 15000 } }],
    [['build_command'], { pipeline: { buildCommand: 'npm run build' } }],
    [['lint_command'], { pipeline: { lintCommand: 'npm run lint' } }],
    [['egress_allowlist'], { networking: { egressAllowlist: ['registry.example.com'] } }],
    [['cedar_policies'], { security: { cedarPolicies: ['permit (principal, action, resource);'] } }],
    [['approval_gate_cap'], { security: { approvalGateCap: 25 } }],
    [['mcp_servers'], { assets: { mcpServers: ['registry://mcp_server/acme/pdf-tools@^1.4.1'] } }],
    [['cedar_policy_modules'], { assets: { cedarPolicyModules: ['registry://cedar_policy_module/acme/force-push@~2.0.0'] } }],
    [['skills'], { assets: { skills: ['registry://skill/acme/research@1.0.0'] } }],
    [['compute_type', 'model_id', 'max_turns'], { compute: { type: 'ecs' }, agent: { modelId: 'us.anthropic.claude-sonnet-4-6', maxTurns: 50 } }],
  ])('the update call sets %j and declares exactly the placeholders its expression uses', (columns, props) => {
    const { UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues } = updateCall(createStack(props).template).parameters;
    expect([...new Set(UpdateExpression.match(/#\w+/g))].sort()).toEqual(Object.keys(ExpressionAttributeNames).sort());
    expect([...new Set(UpdateExpression.match(/:\w+/g))].sort()).toEqual(Object.keys(ExpressionAttributeValues).sort());
    expect(Object.keys(ExpressionAttributeValues)).toEqual([':active', ':now', ...columns.map(column => `:${column}`)]);
  });

  test('grants DynamoDB UpdateItem alone', () => {
    const { template } = createStack();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          Match.objectLike({
            Action: 'dynamodb:UpdateItem',
            Effect: 'Allow',
          }),
        ],
      },
    });
  });
});

describe('Blueprint validation', () => {
  test('rejects invalid repo format', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'invalid-no-slash',
      repoTable,
    });

    expect(() => app.synth()).toThrow(/Invalid repo format/);
  });

  test('accepts valid repo format', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'my-org/my-repo',
      repoTable,
    });

    expect(() => app.synth()).not.toThrow();
  });

  test('rejects invalid egress allowlist domain', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'my-org/my-repo',
      repoTable,
      networking: { egressAllowlist: ['INVALID_DOMAIN'] },
    });

    expect(() => app.synth()).toThrow(/Invalid egress allowlist domain/);
  });

  test('accepts valid egress allowlist domains', () => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');

    const repoTable = new dynamodb.Table(stack, 'RepoTable', {
      partitionKey: { name: 'repo', type: dynamodb.AttributeType.STRING },
    });

    new Blueprint(stack, 'Blueprint', {
      repo: 'my-org/my-repo',
      repoTable,
      networking: { egressAllowlist: ['example.com', '*.internal.example.com', 'registry.npmjs.org'] },
    });

    expect(() => app.synth()).not.toThrow();
  });
});

describe('Blueprint agent.modelId validation', () => {
  const GLOBAL = { bedrockGeoRegion: 'global' };

  function synthError(modelId: string, context?: Record<string, unknown>): string {
    try {
      createStack({ agent: { modelId } }, context);
    } catch (err) {
      return (err as Error).message;
    }
    return '';
  }

  test('accepts a granted model under the geography the deployment grants', () => {
    expect(synthError('us.anthropic.claude-opus-5')).toBe('');
    // The colon of a version suffix does not make an ID an ARN.
    expect(synthError('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('');
    expect(synthError('global.anthropic.claude-opus-5', GLOBAL)).toBe('');
  });

  test('rejects a bare foundation-model ID and names the profile form to use', () => {
    const error = synthError('anthropic.claude-opus-5', GLOBAL);
    expect(error).toContain("Invalid agent.modelId: 'anthropic.claude-opus-5'.");
    expect(error).toContain('bare foundation-model ID');
    expect(error).toContain("Use the inference-profile ID 'global.anthropic.claude-opus-5'.");
  });

  test('rejects an unprefixed value that is not a granted model without building a suggestion from it', () => {
    // `opus` is a Claude Code alias.
    const error = synthError('opus', GLOBAL);
    expect(error).toContain("Invalid agent.modelId: 'opus'. It has no geography prefix.");
    expect(error).toContain("Use 'global.<model-id>' with a model this deployment grants (");
    expect(error).toContain('anthropic.claude-opus-5-5');
    expect(error).not.toContain("'global.opus'");
    expect(synthError('anthropic.example-ungranted-model', GLOBAL))
      .toContain("Use 'global.<model-id>' with a model this deployment grants (");
  });

  test('rejects another geography than the one the deployment grants, naming both', () => {
    const error = synthError('us.anthropic.claude-opus-5', GLOBAL);
    expect(error).toContain("a 'us' inference profile");
    expect(error).toContain("grants 'global' profiles");
    expect(error).toContain("Use 'global.anthropic.claude-opus-5'.");
    expect(synthError('global.anthropic.claude-opus-5')).toContain("grants 'us' profiles");
  });

  test('reads a hyphenated geography as one prefix', () => {
    expect(synthError('us-gov.anthropic.claude-opus-5', GLOBAL))
      .toContain("a 'us-gov' inference profile, but this deployment grants 'global' profiles");
  });

  test('rejects a model the deployment does not grant and lists what it grants', () => {
    const error = synthError('global.anthropic.example-ungranted-model', GLOBAL);
    expect(error).toContain("'anthropic.example-ungranted-model' is not a model this deployment grants");
    expect(error).toContain('anthropic.claude-opus-5-5');
    expect(error).toContain("'bedrockModels' context");
    expect(synthError('global.anthropic.claude-opus-5[1m]', GLOBAL))
      .toContain("'anthropic.claude-opus-5[1m]' is not a model this deployment grants");
  });

  test('reads the granted set from the bedrockModels context', () => {
    const context = {
      bedrockModels: ['anthropic.claude-opus-5-5', 'anthropic.claude-haiku-5-5', 'anthropic.example-added'],
    };
    expect(synthError('us.anthropic.example-added', context)).toBe('');
    // The override replaces the default list, so a default it leaves out is not granted.
    expect(synthError('us.anthropic.claude-sonnet-4-6', context))
      .toContain("'anthropic.claude-sonnet-4-6' is not a model this deployment grants");
  });

  test('rejects two geography prefixes and names the single-prefix form', () => {
    const error = synthError('global.us.anthropic.claude-opus-5', GLOBAL);
    expect(error).toContain("two geography prefixes ('global.' then 'us.')");
    expect(error).toContain("Use one: 'global.anthropic.claude-opus-5'.");
    expect(synthError('global.us.opus', GLOBAL)).toContain("Use one: 'global.<model-id>'.");
  });

  test('rejects a geography prefix with no model after it', () => {
    expect(synthError('global.', GLOBAL)).toContain('geography prefix with no model after it');
  });

  test('rejects surrounding whitespace, which would be written as given', () => {
    expect(synthError('global.anthropic.claude-opus-5 ', GLOBAL)).toContain('surrounding whitespace');
    expect(synthError(' global.anthropic.claude-opus-5', GLOBAL)).toContain('surrounding whitespace');
  });

  test('rejects the ARN of a profile as an ARN, not as a bare ID', () => {
    const error = synthError(
      'arn:aws:bedrock:us-east-1:111122223333:inference-profile/global.anthropic.claude-opus-5-5',
      GLOBAL,
    );
    expect(error).toContain('It is an ARN.');
    expect(error).toContain("Use the inference-profile ID 'global.<model-id>'");
    expect(error).not.toContain('bare foundation-model ID');
  });

  test('rejects a token, which cannot be checked at synth', () => {
    const error = synthError(Lazy.string({ produce: () => 'global.anthropic.claude-opus-5' }), GLOBAL);
    expect(error).toContain('unresolved token');
    expect(error).not.toContain('bare foundation-model ID');
  });

  test('reads the context only for a Blueprint that pins a model', () => {
    // An unknown geography is reported by the grant sites. A Blueprint without a model
    // must not report it as well; one with a model cannot be checked without it.
    const unknownGeo = { bedrockGeoRegion: 'usa' };
    expect(() => createStack(undefined, unknownGeo)).not.toThrow();
    expect(synthError('us.anthropic.claude-opus-5', unknownGeo)).toContain("'bedrockGeoRegion' must be one of");
  });
});
