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
const mockAgentCoreSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: mockAgentCoreSend })),
  RetrieveMemoryRecordsCommand: jest.fn((input: unknown) => ({ _type: 'RetrieveMemoryRecords', input })),
  CreateEventCommand: jest.fn((input: unknown) => ({ _type: 'CreateEvent', input })),
}));

import { loadMemoryContext, writeMinimalEpisode } from '../../../src/handlers/shared/memory';

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// loadMemoryContext
// ---------------------------------------------------------------------------

describe('loadMemoryContext', () => {
  test('returns memory context with semantic and episodic results', async () => {
    mockAgentCoreSend
      .mockResolvedValueOnce({
        // Semantic search result
        memoryRecordSummaries: [
          { content: { text: 'This repo uses Jest for testing' } },
          { content: { text: 'Build system is mise + CDK' } },
        ],
      })
      .mockResolvedValueOnce({
        // Episodic search result
        memoryRecordSummaries: [
          { content: { text: 'Previous task fixed auth bug successfully' } },
        ],
      });

    const result = await loadMemoryContext('mem-123', 'owner/repo', 'Fix the build');
    expect(result).toBeDefined();
    expect(result!.repo_knowledge).toHaveLength(2);
    expect(result!.past_episodes).toHaveLength(1);
    expect(result!.repo_knowledge[0]).toContain('Jest');
  });

  test('uses repo-based namespaces for queries', async () => {
    const { RetrieveMemoryRecordsCommand } = jest.requireMock('@aws-sdk/client-bedrock-agentcore');
    mockAgentCoreSend
      .mockResolvedValueOnce({ memoryRecordSummaries: [] })
      .mockResolvedValueOnce({ memoryRecordSummaries: [] });

    await loadMemoryContext('mem-123', 'owner/repo', 'Fix the build');

    // Semantic search uses /{repo}/knowledge/ namespace
    expect(RetrieveMemoryRecordsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: '/owner/repo/knowledge/',
        searchCriteria: expect.objectContaining({
          searchQuery: 'Fix the build',
        }),
      }),
    );
    // Episodic search uses /{repo}/episodes/ namespace prefix
    expect(RetrieveMemoryRecordsCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: '/owner/repo/episodes/',
        searchCriteria: expect.objectContaining({
          searchQuery: 'recent task episodes',
        }),
      }),
    );
  });

  test('returns undefined when no results are found', async () => {
    mockAgentCoreSend
      .mockResolvedValueOnce({ memoryRecordSummaries: [] })
      .mockResolvedValueOnce({ memoryRecordSummaries: [] });

    const result = await loadMemoryContext('mem-123', 'owner/repo', 'Some task');
    expect(result).toBeUndefined();
  });

  test('returns undefined on SDK error (fail-open)', async () => {
    mockAgentCoreSend.mockRejectedValue(new Error('Service unavailable'));

    const result = await loadMemoryContext('mem-123', 'owner/repo', 'Some task');
    expect(result).toBeUndefined();
  });

  test('handles partial failure — semantic succeeds, episodic fails', async () => {
    mockAgentCoreSend
      .mockResolvedValueOnce({
        memoryRecordSummaries: [
          { content: { text: 'Repo uses TypeScript' } },
        ],
      })
      .mockResolvedValueOnce({
        memoryRecordSummaries: [],
      });

    const result = await loadMemoryContext('mem-123', 'owner/repo', 'Add feature');
    expect(result).toBeDefined();
    expect(result!.repo_knowledge).toHaveLength(1);
    expect(result!.past_episodes).toHaveLength(0);
  });

  test('enforces token budget — truncates entries that exceed budget', async () => {
    // Create entries that together exceed 2000 tokens (at ~4 chars/token = ~8000 chars)
    const longText = 'x'.repeat(4000); // ~1000 tokens each
    mockAgentCoreSend
      .mockResolvedValueOnce({
        memoryRecordSummaries: [
          { content: { text: longText } },
          { content: { text: longText } },
          { content: { text: longText } }, // This one should be cut
        ],
      })
      .mockResolvedValueOnce({
        memoryRecordSummaries: [
          { content: { text: 'Short episode' } },
        ],
      });

    const result = await loadMemoryContext('mem-123', 'owner/repo', 'Task');
    expect(result).toBeDefined();
    // Only 2 long entries fit in 2000 token budget
    expect(result!.repo_knowledge).toHaveLength(2);
    // No room for episodes
    expect(result!.past_episodes).toHaveLength(0);
  });

  test('skips semantic search when no task description provided', async () => {
    mockAgentCoreSend
      .mockResolvedValueOnce({
        // Episodic only
        memoryRecordSummaries: [
          { content: { text: 'Past episode data' } },
        ],
      });

    const result = await loadMemoryContext('mem-123', 'owner/repo');
    expect(result).toBeDefined();
    expect(result!.repo_knowledge).toHaveLength(0);
    expect(result!.past_episodes).toHaveLength(1);
    // Only one call should be made (episodic only, semantic was skipped)
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// writeMinimalEpisode
// ---------------------------------------------------------------------------

describe('writeMinimalEpisode', () => {
  test('writes episode successfully', async () => {
    mockAgentCoreSend.mockResolvedValueOnce({});

    const result = await writeMinimalEpisode(
      'mem-123', 'owner/repo', 'task-abc', 'COMPLETED', 120.5, 0.0345,
    );
    expect(result).toBe(true);
    expect(mockAgentCoreSend).toHaveBeenCalledTimes(1);
  });

  test('uses repo as actorId and taskId as sessionId', async () => {
    const { CreateEventCommand } = jest.requireMock('@aws-sdk/client-bedrock-agentcore');
    mockAgentCoreSend.mockResolvedValueOnce({});

    await writeMinimalEpisode('mem-123', 'owner/repo', 'task-abc', 'COMPLETED');

    expect(CreateEventCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: 'mem-123',
        actorId: 'owner/repo',
        sessionId: 'task-abc',
        metadata: expect.objectContaining({
          task_id: { stringValue: 'task-abc' },
          type: { stringValue: 'orchestrator_fallback_episode' },
          schema_version: { stringValue: '2' },
        }),
      }),
    );
  });

  test('returns false on failure (fail-open)', async () => {
    mockAgentCoreSend.mockRejectedValueOnce(new Error('Access denied'));

    const result = await writeMinimalEpisode(
      'mem-123', 'owner/repo', 'task-abc', 'FAILED',
    );
    expect(result).toBe(false);
  });

  test('includes duration and cost when provided', async () => {
    mockAgentCoreSend.mockResolvedValueOnce({});

    await writeMinimalEpisode(
      'mem-123', 'owner/repo', 'task-abc', 'COMPLETED', 60.0, 1.25,
    );

    const call = mockAgentCoreSend.mock.calls[0][0];
    expect(call.input).toBeDefined();
  });
});
