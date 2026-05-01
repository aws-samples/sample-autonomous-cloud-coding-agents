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

// --- Mocks ---
const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: jest.fn(() => ({})) }));
jest.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: jest.fn(() => ({ send: mockDdbSend })) },
  GetCommand: jest.fn((input: unknown) => ({ _type: 'Get', input })),
  PutCommand: jest.fn((input: unknown) => ({ _type: 'Put', input })),
  UpdateCommand: jest.fn((input: unknown) => ({ _type: 'Update', input })),
}));

const mockAgentCoreSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockAgentCoreSend })),
  InvokeAgentRuntimeCommand: jest.fn((input: unknown) => ({ _type: 'InvokeAgentRuntime', input })),
  StopRuntimeSessionCommand: jest.fn((input: unknown) => ({ _type: 'StopRuntimeSession', input })),
}));

const mockHydrateContext = jest.fn();
jest.mock('../../src/handlers/shared/context-hydration', () => ({
  hydrateContext: mockHydrateContext,
}));

const mockWriteMinimalEpisode = jest.fn();
jest.mock('../../src/handlers/shared/memory', () => ({
  writeMinimalEpisode: mockWriteMinimalEpisode,
}));

const mockComputePromptVersion = jest.fn().mockReturnValue('abc123def456');
jest.mock('../../src/handlers/shared/prompt-version', () => ({
  computePromptVersion: mockComputePromptVersion,
}));

const mockLoadRepoConfig = jest.fn();
jest.mock('../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: mockLoadRepoConfig,
  checkRepoOnboarded: jest.fn(),
}));

let ulidCounter = 0;
jest.mock('ulid', () => ({ ulid: jest.fn(() => `ULID${ulidCounter++}`) }));

// Set env vars before importing (module-level constants are captured at import time)
process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.USER_CONCURRENCY_TABLE_NAME = 'UserConcurrency';
process.env.RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test';
process.env.MAX_CONCURRENT_TASKS_PER_USER = '3';
process.env.TASK_RETENTION_DAYS = '90';
process.env.MEMORY_ID = 'mem-test-default';

import {
  admissionControl,
  emitTaskEvent,
  failTask,
  finalizeTask,
  hydrateAndTransition,
  loadBlueprintConfig,
  loadTask,
  pollTaskStatus,
  transitionTask,
} from '../../src/handlers/shared/orchestrator';

const baseTask = {
  task_id: 'TASK001',
  user_id: 'user-123',
  status: 'SUBMITTED',
  repo: 'org/repo',
  branch_name: 'bgagent/TASK001/fix-bug',
  channel_source: 'api',
  status_created_at: 'SUBMITTED#2024-01-01T00:00:00Z',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  task_description: 'Fix the bug',
};

beforeEach(() => {
  jest.clearAllMocks();
  ulidCounter = 0;
  mockLoadRepoConfig.mockResolvedValue(null);
});

describe('loadTask', () => {
  test('returns task record when found', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: baseTask });
    const result = await loadTask('TASK001');
    expect(result.task_id).toBe('TASK001');
  });

  test('throws when task not found', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    await expect(loadTask('MISSING')).rejects.toThrow('Task MISSING not found');
  });
});

describe('admissionControl', () => {
  test('returns true when concurrency slot is available', async () => {
    mockDdbSend.mockResolvedValueOnce({});
    const result = await admissionControl(baseTask as any);
    expect(result).toBe(true);
  });

  test('returns false when concurrency limit reached', async () => {
    const condErr = new Error('Conditional check failed');
    condErr.name = 'ConditionalCheckFailedException';
    mockDdbSend.mockRejectedValueOnce(condErr);
    const result = await admissionControl(baseTask as any);
    expect(result).toBe(false);
  });

  test('throws on unexpected DDB errors', async () => {
    mockDdbSend.mockRejectedValueOnce(new Error('DynamoDB error'));
    await expect(admissionControl(baseTask as any)).rejects.toThrow('DynamoDB error');
  });
});

describe('hydrateAndTransition', () => {
  const mockHydratedContext = {
    version: 1,
    user_prompt: 'Task ID: TASK001\nRepository: org/repo\n\n## Task\n\nFix the bug',
    sources: ['task_description'],
    token_estimate: 20,
    truncated: false,
    content_trust: { task_description: 'trusted' },
  };

  test('transitions to HYDRATING and returns payload with hydrated_context', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any);
    expect(payload.repo_url).toBe('org/repo');
    expect(payload.task_id).toBe('TASK001');
    expect(payload.branch_name).toBe('bgagent/TASK001/fix-bug');
    expect(payload.prompt).toBe('Fix the bug');
    expect(payload.hydrated_context).toEqual(mockHydratedContext);
  });

  test('includes issue_number when present', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce({ ...mockHydratedContext, sources: ['issue', 'task_description'] });
    const taskWithIssue = { ...baseTask, issue_number: 42 };
    const payload = await hydrateAndTransition(taskWithIssue as any);
    expect(payload.issue_number).toBe('42');
    expect(payload.hydrated_context).toBeDefined();
  });

  test('includes max_turns in payload when present on task record', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const taskWithMaxTurns = { ...baseTask, max_turns: 50 };
    const payload = await hydrateAndTransition(taskWithMaxTurns as any);
    expect(payload.max_turns).toBe(50);
  });

  test('defaults max_turns to 100 when not on task record and no blueprint config', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any);
    expect(payload.max_turns).toBe(100);
  });

  test('threads trace: true into the agent payload when set on the task record', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const taskWithTrace = { ...baseTask, trace: true };
    const payload = await hydrateAndTransition(taskWithTrace as any);
    expect(payload.trace).toBe(true);
  });

  test('omits trace from payload when task record has no trace flag (slim wire)', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any);
    expect(payload).not.toHaveProperty('trace');
  });

  test('threads user_id into the agent payload (design §10.1 — required for trace S3 key)', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any);
    // user_id is threaded unconditionally (not just when trace=true)
    // so that a future feature needing it does not have to re-plumb.
    // The agent only USES it when trace=true.
    expect(payload.user_id).toBe('user-123');
  });

  test('threads user_id even when trace flag is absent', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const taskNoTrace = { ...baseTask, trace: undefined };
    const payload = await hydrateAndTransition(taskNoTrace as any);
    expect(payload.user_id).toBe('user-123');
    expect(payload).not.toHaveProperty('trace');
  });

  test('payload.user_id is undefined when the task record lacks user_id (defensive)', async () => {
    // Defends the Stage 3 ↔ Stage 4 contract: a legacy / corrupted
    // record without ``user_id`` should surface as ``undefined`` in
    // the payload (which JSON.stringify drops entirely), not get
    // silently coerced to an empty string that would then combine
    // with ``trace=true`` to produce an unreachable ``traces//...``
    // S3 key. Admission-control should catch this upstream; test
    // pins the downstream behavior regardless.
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const taskNoUser = { ...baseTask };
    delete (taskNoUser as { user_id?: string }).user_id;
    const payload = await hydrateAndTransition(taskNoUser as any);
    expect(payload.user_id).toBeUndefined();
  });

  test('throws when guardrail_blocked is set on hydrated context', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce({
      ...mockHydratedContext,
      guardrail_blocked: 'PR context blocked by content policy',
    });
    const prTask = { ...baseTask, task_type: 'pr_iteration', pr_number: 10 };
    await expect(hydrateAndTransition(prTask as any)).rejects.toThrow(
      'Guardrail blocked: PR context blocked by content policy',
    );

    // Verify guardrail_blocked event was emitted before the throw
    const putCalls = mockDdbSend.mock.calls
      .filter((c: any) => c[0]._type === 'Put')
      .map((c: any) => c[0].input.Item);
    const guardrailEvent = putCalls.find((item: any) => item.event_type === 'guardrail_blocked');
    expect(guardrailEvent).toBeDefined();
    expect(guardrailEvent.metadata.reason).toBe('PR context blocked by content policy');
    expect(guardrailEvent.metadata.task_type).toBe('pr_iteration');
    expect(guardrailEvent.metadata.pr_number).toBe(10);
    expect(guardrailEvent.metadata.sources).toEqual(['task_description']);
    expect(guardrailEvent.metadata.token_estimate).toBe(20);
    expect(guardrailEvent.metadata.content_trust).toEqual({ task_description: 'trusted' });
  });

  test('still throws guardrail error when emitTaskEvent fails during guardrail_blocked handling', async () => {
    let callCount = 0;
    mockDdbSend.mockImplementation(() => {
      callCount++;
      // First two calls succeed (transitionTask SUBMITTED->HYDRATING, emitTaskEvent hydration_started)
      // Third call is emitTaskEvent('guardrail_blocked') — fail it
      if (callCount === 3) return Promise.reject(new Error('DDB write failed'));
      return Promise.resolve({});
    });
    mockHydrateContext.mockResolvedValueOnce({
      ...mockHydratedContext,
      guardrail_blocked: 'PR context blocked by content policy',
    });
    const prTask = { ...baseTask, task_type: 'pr_iteration', pr_number: 10 };
    await expect(hydrateAndTransition(prTask as any)).rejects.toThrow(
      'Guardrail blocked: PR context blocked by content policy',
    );
  });

  test('hydration_complete event includes source metadata', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    await hydrateAndTransition(baseTask as any);
    // Find the hydration_complete PutCommand (third DDB call: transitionTask, hydration_started, hydration_complete)
    const putCalls = mockDdbSend.mock.calls.filter(
      (call: any[]) => call[0]._type === 'Put' && call[0].input.Item.event_type === 'hydration_complete',
    );
    expect(putCalls).toHaveLength(1);
    const metadata = putCalls[0][0].input.Item.metadata;
    expect(metadata.sources).toEqual(['task_description']);
    expect(metadata.token_estimate).toBe(20);
    expect(metadata.truncated).toBe(false);
    expect(metadata.content_trust).toEqual({ task_description: 'trusted' });
  });
});

describe('pollTaskStatus', () => {
  test('increments attempt count and reads status', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: { status: 'RUNNING' } });
    const result = await pollTaskStatus('TASK001', { attempts: 5 }, 'agentcore');
    expect(result.attempts).toBe(6);
    expect(result.lastStatus).toBe('RUNNING');
    expect(result.sessionUnhealthy).toBe(false);
  });

  test('handles missing item gracefully', async () => {
    mockDdbSend.mockResolvedValueOnce({ Item: undefined });
    const result = await pollTaskStatus('TASK001', { attempts: 0 }, 'agentcore');
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toBeUndefined();
  });

  test('sets sessionUnhealthy when agent heartbeat is stale (RUNNING)', async () => {
    const old = new Date(Date.now() - 400_000).toISOString();
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        status: 'RUNNING',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: old,
        agent_heartbeat_at: old,
      },
    });
    const result = await pollTaskStatus('TASK001', { attempts: 1 }, 'agentcore');
    expect(result.sessionUnhealthy).toBe(true);
  });

  test('does not set sessionUnhealthy when heartbeat is fresh', async () => {
    const started = new Date(Date.now() - 200_000).toISOString();
    const hb = new Date(Date.now() - 30_000).toISOString();
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        status: 'RUNNING',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: started,
        agent_heartbeat_at: hb,
      },
    });
    const result = await pollTaskStatus('TASK001', { attempts: 1 }, 'agentcore');
    expect(result.sessionUnhealthy).toBe(false);
  });

  test('does not set sessionUnhealthy when agent_heartbeat_at is absent but within grace period', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        status: 'RUNNING',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const result = await pollTaskStatus('TASK001', { attempts: 1 }, 'agentcore');
    expect(result.sessionUnhealthy).toBe(false);
  });

  test('sets sessionUnhealthy when agent_heartbeat_at is absent and past grace + stale window', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        status: 'RUNNING',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: new Date(Date.now() - 400_000).toISOString(),
      },
    });
    const result = await pollTaskStatus('TASK001', { attempts: 1 }, 'agentcore');
    expect(result.sessionUnhealthy).toBe(true);
  });

  test('does not set sessionUnhealthy for ECS when agent_heartbeat_at is absent and old', async () => {
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        status: 'RUNNING',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: new Date(Date.now() - 400_000).toISOString(),
      },
    });
    const result = await pollTaskStatus('TASK001', { attempts: 1 }, 'ecs');
    expect(result.sessionUnhealthy).toBe(false);
  });

  test('does not set sessionUnhealthy for ECS even when agent_heartbeat_at is present and stale', async () => {
    const old = new Date(Date.now() - 400_000).toISOString();
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        status: 'RUNNING',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: old,
        agent_heartbeat_at: old,
      },
    });
    const result = await pollTaskStatus('TASK001', { attempts: 1 }, 'ecs');
    expect(result.sessionUnhealthy).toBe(false);
  });

  test('keeps AgentCore stale-heartbeat behavior when compute type is agentcore', async () => {
    const old = new Date(Date.now() - 400_000).toISOString();
    mockDdbSend.mockResolvedValueOnce({
      Item: {
        status: 'RUNNING',
        session_id: '550e8400-e29b-41d4-a716-446655440000',
        started_at: old,
        agent_heartbeat_at: old,
      },
    });
    const result = await pollTaskStatus('TASK001', { attempts: 1 }, 'agentcore');
    expect(result.sessionUnhealthy).toBe(true);
  });
});

describe('loadBlueprintConfig', () => {
  test('returns platform defaults when no repo config exists', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce(null);
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.compute_type).toBe('agentcore');
    expect(config.runtime_arn).toBe('arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test');
  });

  test('merges per-repo config with platform defaults', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom',
      model_id: 'anthropic.claude-sonnet-4-6',
      max_turns: 50,
      poll_interval_ms: 15000,
    });
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.runtime_arn).toBe('arn:aws:bedrock-agentcore:us-east-1:123:runtime/custom');
    expect(config.model_id).toBe('anthropic.claude-sonnet-4-6');
    expect(config.max_turns).toBe(50);
    expect(config.poll_interval_ms).toBe(15000);
  });

  test('uses per-repo github_token_secret_arn when available', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      github_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:per-repo-token',
    });
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.github_token_secret_arn).toBe('arn:aws:secretsmanager:us-east-1:123:secret:per-repo-token');
  });

  test('clamps poll_interval_ms below minimum to 5000', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      poll_interval_ms: 1000,
    });
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.poll_interval_ms).toBe(5000);
  });

  test('clamps poll_interval_ms above maximum to 300000', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      poll_interval_ms: 600000,
    });
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.poll_interval_ms).toBe(300000);
  });

  test('leaves poll_interval_ms unchanged when within range', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      poll_interval_ms: 30000,
    });
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.poll_interval_ms).toBe(30000);
  });

  test('returns undefined poll_interval_ms when repo config has none', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    });
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.poll_interval_ms).toBeUndefined();
  });

  test('passes cedar_policies from repo config', async () => {
    const policies = ['forbid (principal, action, resource) when { resource == Agent::Tool::"Bash" };'];
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      cedar_policies: policies,
    });
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.cedar_policies).toEqual(policies);
  });

  test('returns undefined cedar_policies when repo config has none', async () => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    });
    const config = await loadBlueprintConfig(baseTask as any);
    expect(config.cedar_policies).toBeUndefined();
  });
});

describe('hydrateAndTransition with blueprint config', () => {
  const mockHydratedContext = {
    version: 1,
    user_prompt: 'Task ID: TASK001\nRepository: org/repo\n\n## Task\n\nFix the bug',
    sources: ['task_description'],
    token_estimate: 20,
    truncated: false,
    content_trust: { task_description: 'trusted' },
  };

  test('includes system_prompt_overrides in payload when blueprint config has them', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
      system_prompt_overrides: 'Always use TypeScript.',
    });
    expect(payload.system_prompt_overrides).toBe('Always use TypeScript.');
  });

  test('includes model_id in payload when blueprint config has it', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
      model_id: 'anthropic.claude-sonnet-4-6',
    });
    expect(payload.model_id).toBe('anthropic.claude-sonnet-4-6');
  });

  test('omits model_id from payload when blueprint config does not have it', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
    });
    expect(payload.model_id).toBeUndefined();
  });

  test('uses blueprint max_turns when task record has none', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
      max_turns: 75,
    });
    expect(payload.max_turns).toBe(75);
  });

  test('task-level max_turns overrides blueprint max_turns', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const taskWithMaxTurns = { ...baseTask, max_turns: 25 };
    const payload = await hydrateAndTransition(taskWithMaxTurns as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
      max_turns: 75,
    });
    expect(payload.max_turns).toBe(25);
  });

  test('passes githubTokenSecretArn option to hydrateContext', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    await hydrateAndTransition(baseTask as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
      github_token_secret_arn: 'arn:aws:secretsmanager:us-east-1:123:secret:per-repo-token',
    });
    expect(mockHydrateContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ githubTokenSecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:per-repo-token' }),
    );
  });

  test('includes cedar_policies in payload when blueprint config has them', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const policies = ['forbid (principal, action, resource) when { resource == Agent::Tool::"Bash" };'];
    const payload = await hydrateAndTransition(baseTask as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
      cedar_policies: policies,
    });
    expect(payload.cedar_policies).toEqual(policies);
  });

  test('omits cedar_policies from payload when blueprint config has none', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
    });
    expect(payload.cedar_policies).toBeUndefined();
  });

  test('omits cedar_policies from payload when array is empty', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContext);
    const payload = await hydrateAndTransition(baseTask as any, {
      compute_type: 'agentcore',
      runtime_arn: 'arn:test',
      cedar_policies: [],
    });
    expect(payload.cedar_policies).toBeUndefined();
  });
});

describe('finalizeTask', () => {
  test('handles already-terminal task', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED' } }) // loadTask
      .mockResolvedValue({}); // emitTaskEvent + decrementConcurrency
    await finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123');
    // Verify emitTaskEvent was called (PutCommand)
    expect(mockDdbSend).toHaveBeenCalled();
  });

  test('transitions RUNNING to FAILED when pollState.sessionUnhealthy', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'RUNNING' } }) // loadTask
      .mockResolvedValue({}); // transitionTask + emitTaskEvent + decrementConcurrency
    await finalizeTask(
      'TASK001',
      { attempts: 12, lastStatus: 'RUNNING', sessionUnhealthy: true },
      'user-123',
    );
    const transitionCall = mockDdbSend.mock.calls[1][0];
    expect(transitionCall.input.ExpressionAttributeValues[':toStatus']).toBe('FAILED');
    expect(transitionCall.input.ExpressionAttributeValues[':fromStatus']).toBe('RUNNING');
    const eventCall = mockDdbSend.mock.calls[2][0];
    expect(eventCall.input.Item.event_type).toBe('task_failed');
    expect(eventCall.input.Item.metadata.reason).toBe('agent_heartbeat_stale');
  });

  test('transitions RUNNING to TIMED_OUT on poll timeout', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'RUNNING' } }) // loadTask
      .mockResolvedValue({}); // transitionTask + emitTaskEvent + decrementConcurrency
    await finalizeTask('TASK001', { attempts: 1020, lastStatus: 'RUNNING' }, 'user-123');
    expect(mockDdbSend).toHaveBeenCalled();
  });

  test('transitions HYDRATING to FAILED when session never started', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'HYDRATING' } }) // loadTask
      .mockResolvedValue({}); // transitionTask + emitTaskEvent + decrementConcurrency
    await finalizeTask('TASK001', { attempts: 15, lastStatus: 'HYDRATING' }, 'user-123');
    // First call: loadTask, second call: transitionTask (HYDRATING -> FAILED)
    const transitionCall = mockDdbSend.mock.calls[1][0];
    expect(transitionCall.input.ExpressionAttributeValues[':toStatus']).toBe('FAILED');
    expect(transitionCall.input.ExpressionAttributeValues[':fromStatus']).toBe('HYDRATING');
    // Third call: emitTaskEvent (task_failed with session_never_started)
    const eventCall = mockDdbSend.mock.calls[2][0];
    expect(eventCall.input.Item.event_type).toBe('task_failed');
    expect(eventCall.input.Item.metadata.reason).toBe('session_never_started');
  });

  test('releases concurrency for unexpected task state', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'SUBMITTED' } }) // loadTask
      .mockResolvedValue({}); // decrementConcurrency
    await finalizeTask('TASK001', { attempts: 5, lastStatus: 'SUBMITTED' }, 'user-123');
    // Should still call decrementConcurrency (UpdateCommand for user concurrency)
    const lastCall = mockDdbSend.mock.calls[mockDdbSend.mock.calls.length - 1][0];
    expect(lastCall.input.Key).toEqual({ user_id: 'user-123' });
  });

  test('resolves without throwing when decrementConcurrency hits ConditionalCheckFailedException', async () => {
    const condErr = new Error('Conditional check failed');
    condErr.name = 'ConditionalCheckFailedException';
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED', memory_written: true } }) // loadTask
      .mockResolvedValueOnce({}) // TTL stamp
      .mockResolvedValueOnce({}) // emitTaskEvent
      .mockRejectedValueOnce(condErr); // decrementConcurrency CCF
    await expect(finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123')).resolves.toBeUndefined();
  });

  test('resolves without throwing when decrementConcurrency hits a non-CCF error', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED', memory_written: true } }) // loadTask
      .mockResolvedValueOnce({}) // TTL stamp
      .mockResolvedValueOnce({}) // emitTaskEvent
      .mockRejectedValueOnce(new Error('DDB timeout')); // decrementConcurrency non-CCF
    await expect(finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123')).resolves.toBeUndefined();
  });
});

describe('failTask', () => {
  test('transitions to FAILED and emits event', async () => {
    mockDdbSend.mockResolvedValue({});
    await failTask('TASK001', 'SUBMITTED', 'concurrency limit', 'user-123', false);
    expect(mockDdbSend).toHaveBeenCalled();
  });

  test('releases concurrency when requested', async () => {
    mockDdbSend.mockResolvedValue({});
    await failTask('TASK001', 'HYDRATING', 'hydration error', 'user-123', true);
    // transitionTask + emitTaskEvent + decrementConcurrency = 3 calls
    expect(mockDdbSend).toHaveBeenCalledTimes(3);
  });

  test('transitions from HYDRATING to FAILED when called with HYDRATING status', async () => {
    mockDdbSend.mockResolvedValue({});
    await failTask('TASK001', 'HYDRATING', 'Guardrail blocked: PR context blocked by content policy', 'user-123', true);
    // First call: transitionTask UpdateCommand
    const transitionCall = mockDdbSend.mock.calls[0][0];
    expect(transitionCall.input.ExpressionAttributeValues[':fromStatus']).toBe('HYDRATING');
    expect(transitionCall.input.ExpressionAttributeValues[':toStatus']).toBe('FAILED');
  });

  test('handles transition failure gracefully', async () => {
    mockDdbSend
      .mockRejectedValueOnce(new Error('Condition failed')) // transitionTask
      .mockResolvedValue({}); // emitTaskEvent
    // Should not throw
    await failTask('TASK001', 'SUBMITTED', 'error', 'user-123', false);
  });
});

describe('emitTaskEvent', () => {
  test('writes event to DynamoDB with TTL', async () => {
    mockDdbSend.mockResolvedValueOnce({});
    await emitTaskEvent('TASK001', 'task_created', { repo: 'org/repo' });
    expect(mockDdbSend).toHaveBeenCalledTimes(1);
    const putCall = mockDdbSend.mock.calls[0][0];
    expect(putCall.input.Item.ttl).toBeDefined();
    expect(typeof putCall.input.Item.ttl).toBe('number');
    expect(putCall.input.Item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
});

describe('transitionTask', () => {
  test('rejects invalid transitions', async () => {
    await expect(transitionTask('TASK001', 'COMPLETED' as any, 'RUNNING' as any)).rejects.toThrow(
      'Invalid transition: COMPLETED -> RUNNING',
    );
    expect(mockDdbSend).not.toHaveBeenCalled();
  });
});

describe('transitionTask TTL stamping', () => {
  test('stamps TTL when transitioning to terminal state FAILED', async () => {
    mockDdbSend.mockResolvedValueOnce({}); // UpdateCommand
    // Use failTask which calls transitionTask with FAILED
    mockDdbSend.mockResolvedValue({}); // remaining calls
    await failTask('TASK001', 'SUBMITTED', 'concurrency limit', 'user-123', false);
    // First call is transitionTask UpdateCommand
    const updateCall = mockDdbSend.mock.calls[0][0];
    expect(updateCall.input.UpdateExpression).toContain('#ttl = :ttl');
    expect(updateCall.input.ExpressionAttributeNames['#ttl']).toBe('ttl');
    expect(typeof updateCall.input.ExpressionAttributeValues[':ttl']).toBe('number');
  });
});

describe('finalizeTask TTL stamping', () => {
  test('stamps TTL on task already in terminal state', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED' } }) // loadTask
      .mockResolvedValue({}); // UpdateCommand (TTL stamp) + emitTaskEvent + decrementConcurrency
    await finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123');
    // Second call should be the TTL stamp UpdateCommand
    const ttlStampCall = mockDdbSend.mock.calls[1][0];
    expect(ttlStampCall.input.UpdateExpression).toBe('SET #ttl = :ttl');
    expect(ttlStampCall.input.ExpressionAttributeNames['#ttl']).toBe('ttl');
    expect(typeof ttlStampCall.input.ExpressionAttributeValues[':ttl']).toBe('number');
  });

  test('continues if TTL stamp fails', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED' } }) // loadTask
      .mockRejectedValueOnce(new Error('DDB error')) // TTL stamp fails
      .mockResolvedValue({}); // emitTaskEvent + decrementConcurrency
    // Should not throw
    await finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123');
    expect(mockDdbSend).toHaveBeenCalled();
  });
});

describe('hydrateAndTransition — memory and prompt version', () => {
  // MEMORY_ID='mem-test-default' is set before module import and captured as a const.
  const mockHydratedContextBase = {
    version: 1,
    user_prompt: 'Task ID: TASK001\nRepository: org/repo\n\n## Task\n\nFix the bug',
    sources: ['task_description'],
    token_estimate: 20,
    truncated: false,
    content_trust: { task_description: 'trusted' },
  };

  test('passes memoryId to hydrateContext', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContextBase);
    await hydrateAndTransition(baseTask as any);
    expect(mockHydrateContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ memoryId: 'mem-test-default' }),
    );
  });

  test('includes prompt_version and memory_id in payload', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContextBase);
    const payload = await hydrateAndTransition(baseTask as any);
    expect(payload.prompt_version).toBe('abc123def456');
    expect(payload.memory_id).toBe('mem-test-default');
  });

  test('hydration_complete event includes has_memory_context when memory is loaded', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce({
      ...mockHydratedContextBase,
      memory_context: { repo_knowledge: ['test'], past_episodes: [] },
      sources: ['task_description', 'memory'],
      content_trust: { task_description: 'trusted', memory: 'memory' },
    });
    await hydrateAndTransition(baseTask as any);

    const putCalls = mockDdbSend.mock.calls.filter(
      (call: any[]) => call[0]._type === 'Put' && call[0].input?.Item?.event_type === 'hydration_complete',
    );
    expect(putCalls).toHaveLength(1);
    const metadata = putCalls[0][0].input.Item.metadata;
    expect(metadata.has_memory_context).toBe(true);
    expect(metadata.prompt_version).toBe('abc123def456');
    expect(metadata.content_trust).toEqual({ task_description: 'trusted', memory: 'memory' });
  });

  test('stores prompt_version on task record via DDB UpdateCommand', async () => {
    mockDdbSend.mockResolvedValue({});
    mockHydrateContext.mockResolvedValueOnce(mockHydratedContextBase);
    await hydrateAndTransition(baseTask as any);

    // Find the UpdateCommand that stores prompt_version
    const updateCalls = mockDdbSend.mock.calls.filter(
      (call: any[]) => call[0]._type === 'Update' && call[0].input?.ExpressionAttributeNames?.['#pv'] === 'prompt_version',
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][0].input.ExpressionAttributeValues[':pv']).toBe('abc123def456');
  });
});

describe('finalizeTask — memory fallback', () => {
  // MEMORY_ID='mem-test-default' is set before module import and captured as a const.
  test('calls writeMinimalEpisode when memory_written is false', async () => {
    mockWriteMinimalEpisode.mockResolvedValueOnce(true);
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED', memory_written: false } })
      .mockResolvedValue({});
    await finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123');
    expect(mockWriteMinimalEpisode).toHaveBeenCalledWith(
      'mem-test-default', 'org/repo', 'TASK001', 'COMPLETED', undefined, undefined,
    );
  });

  test('skips writeMinimalEpisode when memory_written is true', async () => {
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED', memory_written: true } })
      .mockResolvedValue({});
    await finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123');
    expect(mockWriteMinimalEpisode).not.toHaveBeenCalled();
  });

  test('survives writeMinimalEpisode failure (fail-open)', async () => {
    mockWriteMinimalEpisode.mockRejectedValueOnce(new Error('Access denied'));
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED', memory_written: false } })
      .mockResolvedValue({});
    // Should not throw — the try-catch in finalizeTask prevents crash
    await finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123');
    expect(mockWriteMinimalEpisode).toHaveBeenCalled();
    // decrementConcurrency should still be called (last UpdateCommand for user concurrency)
    const lastCall = mockDdbSend.mock.calls[mockDdbSend.mock.calls.length - 1][0];
    expect(lastCall.input.Key).toEqual({ user_id: 'user-123' });
  });

  test('converts string duration_s and cost_usd to numbers', async () => {
    mockWriteMinimalEpisode.mockResolvedValueOnce(true);
    mockDdbSend
      .mockResolvedValueOnce({
        Item: { ...baseTask, status: 'COMPLETED', memory_written: false, duration_s: '123.4', cost_usd: '0.0567' },
      })
      .mockResolvedValue({});
    await finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123');
    expect(mockWriteMinimalEpisode).toHaveBeenCalledWith(
      'mem-test-default', 'org/repo', 'TASK001', 'COMPLETED', 123.4, 0.0567,
    );
  });

  test('logs warning when writeMinimalEpisode returns false', async () => {
    mockWriteMinimalEpisode.mockResolvedValueOnce(false);
    mockDdbSend
      .mockResolvedValueOnce({ Item: { ...baseTask, status: 'COMPLETED', memory_written: false } })
      .mockResolvedValue({});
    // Should complete without throwing
    await finalizeTask('TASK001', { attempts: 10, lastStatus: 'COMPLETED' }, 'user-123');
    expect(mockWriteMinimalEpisode).toHaveBeenCalled();
  });
});
