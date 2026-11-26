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

import { createHash } from 'crypto';
import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import type { TaskStatusType } from '../../constructs/task-status';
import { logger } from './logger';
import { sanitizeExternalContent } from './sanitization';
import { makeClient } from './ua';

type MemorySourceType =
  | 'agent_episode'
  | 'agent_learning'
  | 'orchestrator_fallback';

/**
 * Memory context loaded from AgentCore Memory for injection into the system prompt.
 */
export interface MemoryContext {
  /** Semantic search results — factual knowledge about the repo. */
  readonly repo_knowledge: string[];
  /** Recent episodic records — summaries of past task interactions. */
  readonly past_episodes: string[];
}

const MEMORY_READ_TIMEOUT_MS = 5_000;
const DEFAULT_MEMORY_TOKEN_BUDGET = 2_000;

const CHARS_PER_TOKEN_ESTIMATE = 4;

const MIN_SCHEMA_VERSION_WITH_CONTENT_HASH = 3;

const COST_USD_DECIMAL_PLACES = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

type IntegrityResult = 'match' | 'mismatch' | 'no_hash';

/**
 * AgentCore's extraction pipeline transforms content (summarization,
 * consolidation), so the hash of extracted records will legitimately
 * differ from the write-time hash.
 */
function checkContentIntegrity(
  text: string,
  metadata?: Record<string, { stringValue?: string }>,
): IntegrityResult {
  const expected = metadata?.content_sha256?.stringValue;
  if (!expected) {
    const schemaVersion = metadata?.schema_version?.stringValue;
    if (schemaVersion && parseInt(schemaVersion, 10) >= MIN_SCHEMA_VERSION_WITH_CONTENT_HASH) {
      logger.warn('Schema v3+ record missing content_sha256 — possible corrupted write', {
        schema_version: schemaVersion,
        source_type: metadata?.source_type?.stringValue ?? '(unknown)',
        metric_type: 'memory_integrity_missing_hash',
      });
    }
    return 'no_hash';
  }
  return hashContent(text) === expected ? 'match' : 'mismatch';
}

interface MemoryRecordSummary {
  content?: { text?: string };
  metadata?: Record<string, { stringValue?: string }>;
}

function processMemoryRecords(
  records: MemoryRecordSummary[],
  out: string[],
  actorNamespace: string,
  namespacePath: string,
  recordType: string,
): void {
  for (const record of records) {
    const text = record.content?.text;
    if (!text) continue;
    const sanitized = sanitizeExternalContent(text);
    if (checkContentIntegrity(sanitized, record.metadata) === 'mismatch') {
      logger.warn('Memory record hash mismatch (expected for extracted records)', {
        actor_namespace: actorNamespace,
        namespace_path: namespacePath,
        record_type: recordType,
        expected_hash: record.metadata?.content_sha256?.stringValue ?? '(none)',
        actual_hash: hashContent(sanitized),
        source_type: record.metadata?.source_type?.stringValue ?? '(unknown)',
        content_length: text.length,
        metric_type: 'memory_integrity_audit',
      });
    }
    out.push(sanitized);
  }
}

let agentCoreClient: BedrockAgentCoreClient | undefined;
function getClient(): BedrockAgentCoreClient {
  if (!agentCoreClient) {
    agentCoreClient = makeClient(BedrockAgentCoreClient);
  }
  return agentCoreClient;
}

/**
 * Load memory context for a repository from AgentCore Memory.
 *
 * Makes two calls:
 * 1. Semantic search (query = task description) for factual repo knowledge
 * 2. Episodic retrieval for recent task interaction summaries
 *
 * Namespaces match the templates configured on the extraction strategies:
 *   - Semantic: `/{actorId}/knowledge/`  (actorId = repo)
 *   - Episodic: `/{actorId}/episodes/`   (covers all sessions and reflections)
 *
 * Both calls use `namespacePath` for hierarchical retrieval — episodic per-task
 * records live at `/{actorId}/episodes/{sessionId}/`, which is below the read path.
 * (`namespace` is an exact match: it would return none of them.)
 *
 * Results are trimmed to `tokenBudget` (knowledge is prioritized before episodes;
 * entries beyond the budget are dropped).
 * Returns `undefined` on any error (fail-open).
 *
 * @param memoryId - the AgentCore Memory resource ID.
 * @param actorNamespace - the namespace key (maps to actorId): "owner/repo" for coding tasks.
 * @param taskDescription - optional task description for semantic search query.
 * @param tokenBudget - token budget of the returned context (estimated at ~4 chars per token).
 * @returns memory context or undefined on failure.
 */
export async function loadMemoryContext(
  memoryId: string,
  actorNamespace: string,
  taskDescription?: string,
  tokenBudget: number = DEFAULT_MEMORY_TOKEN_BUDGET,
): Promise<MemoryContext | undefined> {
  try {
    const client = getClient();

    const semanticNamespacePath = `/${actorNamespace}/knowledge/`;
    const episodicNamespacePath = `/${actorNamespace}/episodes/`;

    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const [semanticResult, episodicResult] = await Promise.all([
      taskDescription
        ? client.send(new RetrieveMemoryRecordsCommand({
          memoryId,
          namespacePath: semanticNamespacePath,
          searchCriteria: {
            searchQuery: taskDescription,
            topK: 5,
          },
        }), { requestTimeout: MEMORY_READ_TIMEOUT_MS }).catch((err: unknown) => {
          logger.warn('Semantic memory search failed', { error: err instanceof Error ? err.message : String(err) });
          return undefined;
        })
        : Promise.resolve(undefined),
      client.send(new RetrieveMemoryRecordsCommand({
        memoryId,
        namespacePath: episodicNamespacePath,
        searchCriteria: {
          searchQuery: 'recent task episodes',
          topK: 3,
        },
      }), { requestTimeout: MEMORY_READ_TIMEOUT_MS }).catch((err: unknown) => {
        logger.warn('Episodic memory search failed', { error: err instanceof Error ? err.message : String(err) });
        return undefined;
      }),
    ]);

    const repoKnowledge: string[] = [];
    const pastEpisodes: string[] = [];

    if (semanticResult?.memoryRecordSummaries) {
      processMemoryRecords(semanticResult.memoryRecordSummaries, repoKnowledge, actorNamespace, semanticNamespacePath, 'repo_knowledge');
    }

    if (episodicResult?.memoryRecordSummaries) {
      processMemoryRecords(episodicResult.memoryRecordSummaries, pastEpisodes, actorNamespace, episodicNamespacePath, 'past_episode');
    }

    if (repoKnowledge.length === 0 && pastEpisodes.length === 0) {
      return undefined;
    }

    let totalTokens = 0;
    const budgetedKnowledge: string[] = [];
    const budgetedEpisodes: string[] = [];

    for (const text of repoKnowledge) {
      const tokens = estimateTokens(text);
      if (totalTokens + tokens > tokenBudget) break;
      totalTokens += tokens;
      budgetedKnowledge.push(text);
    }

    for (const text of pastEpisodes) {
      const tokens = estimateTokens(text);
      if (totalTokens + tokens > tokenBudget) break;
      totalTokens += tokens;
      budgetedEpisodes.push(text);
    }

    if (budgetedKnowledge.length === 0 && budgetedEpisodes.length === 0) {
      return undefined;
    }

    logger.info('Memory context loaded', {
      actor_namespace: actorNamespace,
      repo_knowledge_count: budgetedKnowledge.length,
      past_episodes_count: budgetedEpisodes.length,
      total_tokens: totalTokens,
    });

    return {
      repo_knowledge: budgetedKnowledge,
      past_episodes: budgetedEpisodes,
    };
  } catch (err) {
    const isProgrammingError = err instanceof TypeError
      || err instanceof RangeError
      || err instanceof ReferenceError;
    const level = isProgrammingError ? 'error' : 'warn';
    logger[level]('Memory context load failed (fail-open)', {
      memoryId,
      actor_namespace: actorNamespace,
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      metric_type: isProgrammingError ? 'memory_load_bug' : 'memory_load_infra_failure',
    });
    return undefined; // nosemgrep: ts-silent-success-masking -- memory hydration is fail-open; task proceeds without past episodes when load fails
  }
}

/**
 * Write a minimal task episode to memory as a fallback when the agent container
 * did not write memory (crash, timeout, OOM).
 *
 * Uses `actorId = actorNamespace` and `sessionId = taskId` to match the namespace
 * templates configured on the extraction strategies:
 *   Episodic: `/{actorId}/episodes/{sessionId}/`
 *
 * @param memoryId - the AgentCore Memory resource ID.
 * @param actorNamespace - the namespace key (used as actorId for namespace derivation).
 * @param taskId - the task ID (used as sessionId for namespace derivation).
 * @param status - terminal task status.
 * @param durationS - task duration in seconds.
 * @param costUsd - task cost in USD.
 * @returns true if written successfully, false on failure.
 */
export async function writeMinimalEpisode(
  memoryId: string,
  actorNamespace: string,
  taskId: string,
  status: TaskStatusType,
  durationS?: number,
  costUsd?: number,
): Promise<boolean> {
  try {
    const client = getClient();

    const episodeText = [
      `Task ${taskId} completed with status: ${status}.`,
      durationS !== undefined ? `Duration: ${durationS}s.` : '',
      costUsd !== undefined ? `Cost: $${costUsd.toFixed(COST_USD_DECIMAL_PLACES)}.` : '',
      'Note: This is a minimal episode written by the orchestrator because the agent did not write memory.',
    ].filter(Boolean).join(' ');

    const sanitizedText = sanitizeExternalContent(episodeText);
    const contentHash = hashContent(sanitizedText);

    await client.send(new CreateEventCommand({
      memoryId,
      actorId: actorNamespace,
      sessionId: taskId,
      eventTimestamp: new Date(),
      payload: [{
        conversational: {
          content: { text: episodeText },
          role: 'OTHER',
        },
      }],
      metadata: {
        task_id: { stringValue: taskId },
        type: { stringValue: 'orchestrator_fallback_episode' },
        source_type: { stringValue: 'orchestrator_fallback' as MemorySourceType },
        content_sha256: { stringValue: contentHash },
        schema_version: { stringValue: '3' },
      },
    }));

    logger.info('Minimal episode written by orchestrator fallback', { taskId, actorNamespace });
    return true;
  } catch (err) {
    const isProgrammingError = err instanceof TypeError
      || err instanceof RangeError
      || err instanceof ReferenceError;
    const level = isProgrammingError ? 'error' : 'warn';
    logger[level]('Failed to write minimal episode (fail-open)', {
      memoryId,
      taskId,
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      metric_type: isProgrammingError ? 'memory_write_bug' : 'memory_write_infra_failure',
    });
    return false;
  }
}
