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

import { classifyError, ErrorCategory, type ErrorClassification } from '../../../src/handlers/shared/error-classifier';
import { toTaskDetail, type TaskRecord } from '../../../src/handlers/shared/types';

describe('classifyError', () => {
  // --- Null / empty inputs ---

  test('returns null for undefined', () => {
    expect(classifyError(undefined)).toBeNull();
  });

  test('returns null for null', () => {
    expect(classifyError(null)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(classifyError('')).toBeNull();
  });

  // --- Auth errors ---

  describe('auth errors', () => {
    test('classifies insufficient GitHub repo permissions (preflight)', () => {
      const result = classifyError(
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo.',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Insufficient GitHub permissions');
      expect(result!.retryable).toBe(false);
    });

    test('classifies repo not found or no access', () => {
      const result = classifyError(
        'Pre-flight check failed: REPO_NOT_FOUND_OR_NO_ACCESS — GitHub API returned HTTP 404 for owner/repo',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Repository not found or inaccessible');
      expect(result!.retryable).toBe(false);
    });

    test('classifies PR not found or closed', () => {
      const result = classifyError(
        'Pre-flight check failed: PR_NOT_FOUND_OR_CLOSED — PR #42 in owner/repo is closed, not open',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Pull request not found or closed');
      expect(result!.retryable).toBe(false);
    });

    test('classifies token push scope error (detailed message)', () => {
      const result = classifyError(
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo. Required: push. For fine-grained PATs use Contents Read and write.',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.retryable).toBe(false);
    });

    test('classifies token PR scope error', () => {
      const result = classifyError(
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot interact with pull requests on owner/repo.',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.retryable).toBe(false);
    });

    test('classifies bare "Token cannot push to" without error code', () => {
      const result = classifyError('Token cannot push to owner/repo');
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Insufficient GitHub token scopes');
    });

    test('classifies bare "Token cannot interact with pull requests on" without error code', () => {
      const result = classifyError('Token cannot interact with pull requests on owner/repo');
      expect(result!.category).toBe(ErrorCategory.AUTH);
      expect(result!.title).toBe('Insufficient GitHub token scopes');
    });
  });

  // --- Network errors ---

  describe('network errors', () => {
    test('classifies GitHub unreachable', () => {
      const result = classifyError(
        'Pre-flight check failed: GITHUB_UNREACHABLE — connect ETIMEDOUT 140.82.121.6:443',
      );
      expect(result!.category).toBe(ErrorCategory.NETWORK);
      expect(result!.title).toBe('GitHub API unreachable');
      expect(result!.retryable).toBe(true);
    });

    test('classifies GitHub API HTTP 5xx', () => {
      const result = classifyError(
        'Pre-flight check failed: GITHUB_UNREACHABLE — GitHub API returned HTTP 503',
      );
      expect(result!.category).toBe(ErrorCategory.NETWORK);
      expect(result!.retryable).toBe(true);
    });

    test('classifies GitHub API HTTP 4xx in preflight detail', () => {
      const result = classifyError(
        'Pre-flight check failed: GITHUB_UNREACHABLE — GitHub API returned HTTP 403 for owner/repo',
      );
      expect(result!.category).toBe(ErrorCategory.NETWORK);
      expect(result!.retryable).toBe(true);
    });

    test('classifies bare GitHub API HTTP status without GITHUB_UNREACHABLE', () => {
      const result = classifyError('GitHub API returned HTTP 502 during polling');
      expect(result!.category).toBe(ErrorCategory.NETWORK);
      expect(result!.title).toBe('GitHub API error');
    });
  });

  // --- Concurrency errors ---

  describe('concurrency errors', () => {
    test('classifies user concurrency limit', () => {
      const result = classifyError('User concurrency limit reached');
      expect(result!.category).toBe(ErrorCategory.CONCURRENCY);
      expect(result!.title).toBe('Concurrency limit reached');
      expect(result!.retryable).toBe(true);
    });
  });

  // --- Compute errors ---

  describe('compute errors', () => {
    test('classifies session start failure', () => {
      const result = classifyError('Session start failed: ServiceQuotaExceededException');
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Agent session failed to start');
      expect(result!.retryable).toBe(true);
    });

    test('classifies ECS container failure', () => {
      const result = classifyError('ECS container failed: OutOfMemoryError');
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('ECS container failed');
      expect(result!.retryable).toBe(true);
    });

    test('classifies ECS exit without terminal status', () => {
      const result = classifyError(
        'ECS task exited successfully but agent never wrote terminal status after 5 polls',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Agent exited without reporting status');
      expect(result!.retryable).toBe(true);
    });

    test('classifies ECS poll failures', () => {
      const result = classifyError(
        'ECS poll failed 3 consecutive times: AccessDeniedException',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('ECS polling failure');
      expect(result!.retryable).toBe(true);
    });

    test('classifies session never started (HYDRATING timeout)', () => {
      const result = classifyError(
        'Session never started — poll timeout exceeded while still HYDRATING',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Agent session never started');
      expect(result!.retryable).toBe(true);
    });

    test('classifies agent heartbeat loss', () => {
      const result = classifyError(
        'Agent session lost: no recent heartbeat from the runtime (container may have crashed, been OOM-killed, or stopped)',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
      expect(result!.title).toBe('Agent session lost');
      expect(result!.retryable).toBe(true);
    });
  });

  // --- Agent errors ---

  describe('agent errors', () => {
    test('classifies SDK stream ended without ResultMessage', () => {
      const result = classifyError(
        'Agent SDK stream ended without a ResultMessage (agent_status=unknown). Treat as failure: possible SDK bug, network interruption, or protocol mismatch.',
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.title).toBe('Agent SDK stream ended unexpectedly');
      expect(result!.retryable).toBe(true);
    });

    test('classifies SDK stream ended with chained error', () => {
      const result = classifyError(
        'some prior error; Agent SDK stream ended without a ResultMessage (agent_status=unknown). Treat as failure.',
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.retryable).toBe(true);
    });

    test('classifies task did not succeed', () => {
      const result = classifyError(
        "Task did not succeed (agent_status='error', build_ok=False)",
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.title).toBe('Agent task did not succeed');
      expect(result!.retryable).toBe(false);
    });

    test('classifies receive_response failure', () => {
      const result = classifyError(
        'receive_response() failed: Connection reset by peer',
      );
      expect(result!.category).toBe(ErrorCategory.AGENT);
      expect(result!.title).toBe('Agent communication failure');
      expect(result!.retryable).toBe(true);
    });
  });

  // --- Guardrail errors ---

  describe('guardrail errors', () => {
    test('classifies guardrail blocked during hydration', () => {
      const result = classifyError(
        'Hydration failed: Error: Guardrail blocked: CONTENT_POLICY_VIOLATION',
      );
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
      expect(result!.title).toBe('Content blocked by guardrail');
      expect(result!.retryable).toBe(false);
    });

    test('classifies direct guardrail blocked message', () => {
      const result = classifyError('Guardrail blocked: prompt injection detected');
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
      expect(result!.retryable).toBe(false);
    });

    test('classifies content policy at submission', () => {
      const result = classifyError('Task description was blocked by content policy.');
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
      expect(result!.title).toBe('Content policy violation');
      expect(result!.retryable).toBe(false);
    });
  });

  // --- Config errors ---

  describe('config errors', () => {
    test('classifies blueprint config load failure', () => {
      const result = classifyError(
        'Blueprint config load failed: ResourceNotFoundException: Requested resource not found',
      );
      expect(result!.category).toBe(ErrorCategory.CONFIG);
      expect(result!.title).toBe('Blueprint configuration error');
      expect(result!.retryable).toBe(true);
    });

    test('classifies hydration failure (non-guardrail)', () => {
      const result = classifyError(
        'Hydration failed: Error: Failed to fetch issue body',
      );
      expect(result!.category).toBe(ErrorCategory.CONFIG);
      expect(result!.title).toBe('Context hydration failed');
      expect(result!.retryable).toBe(true);
    });

    test('does not classify hydration + guardrail as config', () => {
      const result = classifyError('Hydration failed: Error: Guardrail blocked: xyz');
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
    });
  });

  // --- Timeout errors ---

  describe('timeout errors', () => {
    test('classifies orchestrator poll timeout', () => {
      const result = classifyError('Orchestrator poll timeout exceeded');
      expect(result!.category).toBe(ErrorCategory.TIMEOUT);
      expect(result!.title).toBe('Task timed out');
      expect(result!.retryable).toBe(false);
    });
  });

  // --- Unknown errors ---

  describe('unknown errors', () => {
    test('classifies unrecognized error as unknown', () => {
      const result = classifyError('Something completely unexpected happened');
      expect(result!.category).toBe(ErrorCategory.UNKNOWN);
      expect(result!.title).toBe('Unexpected error');
      expect(result!.retryable).toBe(false);
    });

    test('classifies raw Python exception from agent as unknown', () => {
      const result = classifyError('ValueError: invalid literal for int()');
      expect(result!.category).toBe(ErrorCategory.UNKNOWN);
    });
  });

  // --- Classification shape ---

  describe('classification shape', () => {
    test('every classification has all required fields', () => {
      const messages = [
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo',
        'Pre-flight check failed: GITHUB_UNREACHABLE — timeout',
        'User concurrency limit reached',
        'Session start failed: boom',
        'Agent SDK stream ended without a ResultMessage (agent_status=unknown).',
        'Guardrail blocked: nope',
        'Blueprint config load failed: boom',
        'Orchestrator poll timeout exceeded',
        'mystery error',
      ];

      for (const msg of messages) {
        const result = classifyError(msg) as ErrorClassification;
        expect(result).toBeDefined();
        expect(typeof result.category).toBe('string');
        expect(typeof result.title).toBe('string');
        expect(typeof result.description).toBe('string');
        expect(typeof result.remedy).toBe('string');
        expect(typeof result.retryable).toBe('boolean');
        expect(result.title.length).toBeGreaterThan(0);
        expect(result.description.length).toBeGreaterThan(0);
        expect(result.remedy.length).toBeGreaterThan(0);
      }
    });
  });

  // --- Priority / ordering ---

  describe('pattern priority', () => {
    test('INSUFFICIENT_GITHUB_REPO_PERMISSIONS takes priority over GITHUB_UNREACHABLE substring', () => {
      const result = classifyError(
        'Pre-flight check failed: INSUFFICIENT_GITHUB_REPO_PERMISSIONS — Token cannot push to owner/repo',
      );
      expect(result!.category).toBe(ErrorCategory.AUTH);
    });

    test('guardrail in hydration message takes priority over generic hydration failure', () => {
      const result = classifyError('Hydration failed: Error: Guardrail blocked: test');
      expect(result!.category).toBe(ErrorCategory.GUARDRAIL);
    });

    test('agent heartbeat loss matches compute, not agent', () => {
      const result = classifyError(
        'Agent session lost: no recent heartbeat from the runtime (container may have crashed, been OOM-killed, or stopped)',
      );
      expect(result!.category).toBe(ErrorCategory.COMPUTE);
    });
  });

  // --- toTaskDetail integration ---

  describe('toTaskDetail integration', () => {
    const baseRecord: TaskRecord = {
      task_id: 'task-1',
      user_id: 'user-1',
      status: 'FAILED',
      repo: 'owner/repo',
      task_type: 'new_task',
      branch_name: 'bgagent/task-1/fix',
      channel_source: 'cli',
      status_created_at: 'FAILED#2026-01-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };

    test('populates error_classification for a known error pattern', () => {
      const record: TaskRecord = { ...baseRecord, error_message: 'User concurrency limit reached' };
      const detail = toTaskDetail(record);
      expect(detail.error_classification).not.toBeNull();
      expect(detail.error_classification!.category).toBe('concurrency');
      expect(detail.error_classification!.title).toBe('Concurrency limit reached');
    });

    test('returns null error_classification when error_message is undefined', () => {
      const detail = toTaskDetail(baseRecord);
      expect(detail.error_message).toBeNull();
      expect(detail.error_classification).toBeNull();
    });

    test('returns unknown classification for unrecognized error_message', () => {
      const record: TaskRecord = { ...baseRecord, error_message: 'ValueError: something broke' };
      const detail = toTaskDetail(record);
      expect(detail.error_classification).not.toBeNull();
      expect(detail.error_classification!.category).toBe('unknown');
    });
  });
});
