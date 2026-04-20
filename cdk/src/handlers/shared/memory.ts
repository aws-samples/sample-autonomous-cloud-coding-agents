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
import { logger } from './logger';
import { sanitizeExternalContent } from './sanitization';
import type { TaskStatusType } from '../../constructs/task-status';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Provenance tag indicating who wrote a memory record.
 * Must stay in sync with Python-side MEMORY_SOURCE_TYPES in agent/src/memory.py.
 */
export type MemorySourceType =
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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MEMORY_READ_TIMEOUT_MS = 5_000;
const MEMORY_TOKEN_BUDGET = 2_000;

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Compute SHA-256 hash of text content (UTF-8 encoded; must match agent/src/memory.py). */
function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Result of content integrity check (audit-only — never gates retrieval). */
type IntegrityResult = 'match' | 'mismatch' | 'no_hash';

/**
 * Check content integrity against a stored SHA-256 hash (audit-only).
 *
 * AgentCore's extraction pipeline transforms content (summarization,
 * consolidation), so the hash of extracted records will legitimately
 * differ from the write-time hash. This check is therefore an audit
 * signal, not a retrieval gate — callers log the result but never
 * discard records based on it.
 */
function checkContentIntegrity(
  text: string,
  metadata?: Record<string, { stringValue?: string }>,
): IntegrityResult {
  const expected = metadata?.content_sha256?.stringValue;
  if (!expected) {
    // v3+ records should always have a hash — missing hash signals a
    // corrupted write or a write-path regression that stopped emitting hashes.
    const schemaVersion = metadata?.schema_version?.stringValue;
    if (schemaVersion && parseInt(schemaVersion, 10) >= 3) {
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

/** Record metadata shape returned by AgentCore RetrieveMemoryRecords. */
interface MemoryRecordSummary {
  content?: { text?: string };
  metadata?: Record<string, { stringValue?: string }>;
}

/**
 * Sanitize, audit-check, and collect text from memory record summaries.
 *
 * Each record is sanitized, integrity-checked (audit-only — mismatches are
 * logged but never cause records to be discarded), and appended to `out`.
 */
function processMemoryRecords(
  records: MemoryRecordSummary[],
  out: string[],
  repo: string,
  namespace: string,
  recordType: string,
): void {
  for (const record of records) {
    const text = record.content?.text;
    if (!text) continue;
    const sanitized = sanitizeExternalContent(text);
    if (checkContentIntegrity(sanitized, record.metadata) === 'mismatch') {
      // Expected for extracted records — AgentCore transforms content
      // during extraction (summarization, consolidation). Log at WARN so
      // CloudWatch alarms can detect spikes (genuine tampering or write bugs).
      logger.warn('Memory record hash mismatch (expected for extracted records)', {
        repo,
        namespace,
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

// Lazy-init client (only created if MEMORY_ID is set)
let agentCoreClient: BedrockAgentCoreClient | undefined;
function getClient(): BedrockAgentCoreClient {
  if (!agentCoreClient) {
    agentCoreClient = new BedrockAgentCoreClient({});
  }
  return agentCoreClient;
}

// ---------------------------------------------------------------------------
// Memory read
// ---------------------------------------------------------------------------

/**
 * Load memory context for a repository from AgentCore Memory.
 *
 * Makes two calls:
 * 1. Semantic search (query = task description) for factual repo knowledge
 * 2. Episodic retrieval for recent task interaction summaries
 *
 * Namespaces match the templates configured on the extraction strategies:
 *   - Semantic: `/{actorId}/knowledge/`  (actorId = repo)
 *   - Episodic: `/{actorId}/episodes/`   (prefix matches all sessions)
 *
 * Results are trimmed to a 2000-token budget (knowledge is prioritized before episodes;
 * entries beyond the budget are dropped).
 * Returns `undefined` on any error (fail-open).
 *
 * @param memoryId - the AgentCore Memory resource ID.
 * @param repo - the "owner/repo" string used as namespace key (maps to actorId).
 * @param taskDescription - optional task description for semantic search query.
 * @returns memory context or undefined on failure.
 */
export async function loadMemoryContext(
  memoryId: string,
  repo: string,
  taskDescription?: string,
): Promise<MemoryContext | undefined> {
  try {
    const client = getClient();

    // Namespaces derived from the strategy templates configured in agent-memory.ts:
    //   Semantic:  /{actorId}/knowledge/
    //   Episodic:  /{actorId}/episodes/{sessionId}/
    // Events are written with actorId = repo (e.g. "krokoko/agent-plugins"),
    // so extracted records land at /{repo}/knowledge/ and /{repo}/episodes/{taskId}/.
    // Reads use these paths as namespace prefixes.
    const semanticNamespace = `/${repo}/knowledge/`;
    const episodicNamespace = `/${repo}/episodes/`;

    // Run semantic and episodic searches in parallel
    // eslint-disable-next-line @cdklabs/promiseall-no-unbounded-parallelism
    const [semanticResult, episodicResult] = await Promise.all([
      // Semantic search — factual knowledge about this repo
      taskDescription
        ? client.send(new RetrieveMemoryRecordsCommand({
          memoryId,
          namespace: semanticNamespace,
          searchCriteria: {
            searchQuery: taskDescription,
            topK: 5,
          },
        }), { requestTimeout: MEMORY_READ_TIMEOUT_MS }).catch((err: unknown) => {
          logger.warn('Semantic memory search failed', { error: err instanceof Error ? err.message : String(err) });
          return undefined;
        })
        : Promise.resolve(undefined),
      // Episodic search — recent task episodes (prefix matches all sessions)
      client.send(new RetrieveMemoryRecordsCommand({
        memoryId,
        namespace: episodicNamespace,
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
      processMemoryRecords(semanticResult.memoryRecordSummaries, repoKnowledge, repo, semanticNamespace, 'repo_knowledge');
    }

    if (episodicResult?.memoryRecordSummaries) {
      processMemoryRecords(episodicResult.memoryRecordSummaries, pastEpisodes, repo, episodicNamespace, 'past_episode');
    }

    if (repoKnowledge.length === 0 && pastEpisodes.length === 0) {
      return undefined;
    }

    // Enforce token budget — trim oldest entries first
    let totalTokens = 0;
    const budgetedKnowledge: string[] = [];
    const budgetedEpisodes: string[] = [];

    for (const text of repoKnowledge) {
      const tokens = estimateTokens(text);
      if (totalTokens + tokens > MEMORY_TOKEN_BUDGET) break;
      totalTokens += tokens;
      budgetedKnowledge.push(text);
    }

    for (const text of pastEpisodes) {
      const tokens = estimateTokens(text);
      if (totalTokens + tokens > MEMORY_TOKEN_BUDGET) break;
      totalTokens += tokens;
      budgetedEpisodes.push(text);
    }

    if (budgetedKnowledge.length === 0 && budgetedEpisodes.length === 0) {
      return undefined;
    }

    logger.info('Memory context loaded', {
      repo,
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
      repo,
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.constructor.name : typeof err,
      metric_type: isProgrammingError ? 'memory_load_bug' : 'memory_load_infra_failure',
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Memory write (orchestrator fallback)
// ---------------------------------------------------------------------------

/**
 * Write a minimal task episode to memory as a fallback when the agent container
 * did not write memory (crash, timeout, OOM).
 *
 * Uses `actorId = repo` and `sessionId = taskId` to match the namespace
 * templates configured on the extraction strategies:
 *   Episodic: `/{actorId}/episodes/{sessionId}/`
 *
 * @param memoryId - the AgentCore Memory resource ID.
 * @param repo - the "owner/repo" string (used as actorId for namespace derivation).
 * @param taskId - the task ID (used as sessionId for namespace derivation).
 * @param status - terminal task status.
 * @param durationS - task duration in seconds.
 * @param costUsd - task cost in USD.
 * @returns true if written successfully, false on failure.
 */
export async function writeMinimalEpisode(
  memoryId: string,
  repo: string,
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
      costUsd !== undefined ? `Cost: $${costUsd.toFixed(4)}.` : '',
      'Note: This is a minimal episode written by the orchestrator because the agent did not write memory.',
    ].filter(Boolean).join(' ');

    // Hash the sanitized form; store the original. The read path re-sanitizes
    // and checks against this hash: sanitize(original) at write == sanitize(stored) at read.
    const sanitizedText = sanitizeExternalContent(episodeText);
    const contentHash = hashContent(sanitizedText);

    await client.send(new CreateEventCommand({
      memoryId,
      actorId: repo,
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

    logger.info('Minimal episode written by orchestrator fallback', { taskId, repo });
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
