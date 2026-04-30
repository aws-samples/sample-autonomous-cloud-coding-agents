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

import { formatEvents, formatJson, formatTaskDetail, formatTaskList, formatWebhookCreated, formatWebhookDetail, formatWebhookList } from '../src/format';
import { CreateWebhookResponse, TaskDetail, TaskEvent, TaskSummary, WebhookDetail } from '../src/types';

describe('format', () => {
  const task: TaskDetail = {
    task_id: 'abc123',
    status: 'COMPLETED',
    repo: 'owner/repo',
    issue_number: 42,
    task_type: 'new_task',
    pr_number: null,
    task_description: 'Fix the bug',
    branch_name: 'bgagent/abc123/fix-the-bug',
    session_id: 'sess-1',
    pr_url: 'https://github.com/owner/repo/pull/1',
    error_message: null,
    error_classification: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T01:00:00Z',
    started_at: '2026-01-01T00:01:00Z',
    completed_at: '2026-01-01T01:00:00Z',
    duration_s: 3540,
    cost_usd: 0.1234,
    build_passed: true,
    max_turns: 100,
    max_budget_usd: null,
  };

  describe('formatTaskDetail', () => {
    test('includes all populated fields', () => {
      const output = formatTaskDetail(task);
      expect(output).toContain('Task:        abc123');
      expect(output).toContain('Status:      COMPLETED');
      expect(output).toContain('Repo:        owner/repo');
      expect(output).toContain('Issue:       #42');
      expect(output).toContain('Description: Fix the bug');
      expect(output).toContain('Branch:      bgagent/abc123/fix-the-bug');
      expect(output).toContain('PR:          https://github.com/owner/repo/pull/1');
      expect(output).toContain('Duration:    3540s');
      expect(output).toContain('Cost:        $0.1234');
      expect(output).toContain('Build:       PASSED');
      expect(output).toContain('Max Turns:   100');
    });

    test('omits null fields', () => {
      const minimal: TaskDetail = {
        ...task,
        issue_number: null,
        task_description: null,
        session_id: null,
        pr_url: null,
        started_at: null,
        completed_at: null,
        duration_s: null,
        cost_usd: null,
        build_passed: null,
        max_turns: null,
      };
      const output = formatTaskDetail(minimal);
      expect(output).not.toContain('Issue:');
      expect(output).not.toContain('Description:');
      expect(output).not.toContain('PR:');
      expect(output).not.toContain('Duration:');
      expect(output).not.toContain('Cost:');
      expect(output).not.toContain('Build:');
      expect(output).not.toContain('Max Turns:');
    });

    test('shows task_type and pr_number for pr_iteration', () => {
      const prTask: TaskDetail = {
        ...task,
        task_type: 'pr_iteration',
        pr_number: 42,
        issue_number: null,
      };
      const output = formatTaskDetail(prTask);
      expect(output).toContain('Type:        pr_iteration');
      expect(output).toContain('PR #:        42');
    });

    test('omits task_type line for new_task', () => {
      const output = formatTaskDetail(task);
      expect(output).not.toContain('Type:');
      expect(output).not.toContain('PR #:');
    });

    test('shows classified error with raw detail when error_classification is present', () => {
      const failedTask: TaskDetail = {
        ...task,
        status: 'FAILED',
        error_message: 'User concurrency limit reached',
        error_classification: {
          category: 'concurrency',
          title: 'Concurrency limit reached',
          description: 'The maximum number of concurrent tasks for this user has been reached.',
          remedy: 'Wait for an active task to complete, cancel a running task, or ask an admin to increase the limit.',
          retryable: true,
        },
      };
      const output = formatTaskDetail(failedTask);
      expect(output).toContain('[CONCURRENCY] Concurrency limit reached');
      expect(output).toContain('The maximum number of concurrent tasks');
      expect(output).toContain('Remedy:');
      expect(output).toContain('Retryable: yes');
      expect(output).toContain('Detail:    User concurrency limit reached');
    });

    test('shows retryable: no for non-retryable errors', () => {
      const failedTask: TaskDetail = {
        ...task,
        status: 'FAILED',
        error_message: 'Guardrail blocked: prompt injection',
        error_classification: {
          category: 'guardrail',
          title: 'Content blocked by guardrail',
          description: 'Bedrock Guardrails blocked the task content.',
          remedy: 'Review the task description for policy violations.',
          retryable: false,
        },
      };
      const output = formatTaskDetail(failedTask);
      expect(output).toContain('[GUARDRAIL] Content blocked by guardrail');
      expect(output).toContain('Retryable: no');
      expect(output).toContain('Detail:    Guardrail blocked: prompt injection');
    });

    test('falls back to raw error_message when classification is absent', () => {
      const failedTask: TaskDetail = {
        ...task,
        status: 'FAILED',
        error_message: 'Something unexpected',
        error_classification: null,
      };
      const output = formatTaskDetail(failedTask);
      expect(output).toContain('Error:       Something unexpected');
    });
  });

  describe('formatTaskList', () => {
    test('shows table with headers', () => {
      const tasks: TaskSummary[] = [{
        task_id: 'abc',
        status: 'RUNNING',
        repo: 'owner/repo',
        issue_number: 1,
        task_type: 'new_task',
        pr_number: null,
        task_description: null,
        branch_name: 'bgagent/abc/fix',
        pr_url: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }];
      const output = formatTaskList(tasks);
      expect(output).toContain('TASK ID');
      expect(output).toContain('STATUS');
      expect(output).toContain('abc');
      expect(output).toContain('RUNNING');
    });

    test('shows task description when present', () => {
      const tasks: TaskSummary[] = [{
        task_id: 'abc',
        status: 'RUNNING',
        repo: 'owner/repo',
        issue_number: null,
        task_type: 'new_task',
        pr_number: null,
        task_description: 'Fix the login bug',
        branch_name: 'bgagent/abc/fix',
        pr_url: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }];
      const output = formatTaskList(tasks);
      expect(output).toContain('Fix the login bug');
      expect(output).not.toContain('#null');
    });

    test('shows issue number when no description', () => {
      const tasks: TaskSummary[] = [{
        task_id: 'abc',
        status: 'RUNNING',
        repo: 'owner/repo',
        issue_number: 42,
        task_type: 'new_task',
        pr_number: null,
        task_description: null,
        branch_name: 'bgagent/abc/fix',
        pr_url: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }];
      const output = formatTaskList(tasks);
      expect(output).toContain('#42');
    });

    test('returns message for empty list', () => {
      expect(formatTaskList([])).toBe('No tasks found.');
    });
  });

  describe('formatEvents', () => {
    test('shows event timeline', () => {
      const events: TaskEvent[] = [{
        event_id: 'evt-1',
        event_type: 'TASK_SUBMITTED',
        timestamp: '2026-01-01T00:00:00Z',
        metadata: { source: 'cli' },
      }];
      const output = formatEvents(events);
      expect(output).toContain('TIMESTAMP');
      expect(output).toContain('EVENT TYPE');
      expect(output).toContain('TASK_SUBMITTED');
    });

    test('returns message for empty events', () => {
      expect(formatEvents([])).toBe('No events found.');
    });
  });

  describe('formatWebhookCreated', () => {
    test('includes webhook fields and secret warning', () => {
      const res: CreateWebhookResponse = {
        webhook_id: 'wh-abc',
        name: 'My CI Pipeline',
        secret: 'whsec_supersecret123',
        created_at: '2026-01-01T00:00:00Z',
      };
      const output = formatWebhookCreated(res);
      expect(output).toContain('Webhook:     wh-abc');
      expect(output).toContain('Name:        My CI Pipeline');
      expect(output).toContain('Created:     2026-01-01T00:00:00Z');
      expect(output).toContain('Secret (store securely — shown only once):');
      expect(output).toContain('whsec_supersecret123');
    });
  });

  describe('formatWebhookList', () => {
    test('shows table with headers', () => {
      const webhooks: WebhookDetail[] = [{
        webhook_id: 'wh-1',
        name: 'CI Pipeline',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        revoked_at: null,
      }];
      const output = formatWebhookList(webhooks);
      expect(output).toContain('WEBHOOK ID');
      expect(output).toContain('NAME');
      expect(output).toContain('STATUS');
      expect(output).toContain('CREATED');
      expect(output).toContain('wh-1');
      expect(output).toContain('active');
    });

    test('returns message for empty list', () => {
      expect(formatWebhookList([])).toBe('No webhooks found.');
    });
  });

  describe('formatWebhookDetail', () => {
    test('includes all fields', () => {
      const webhook: WebhookDetail = {
        webhook_id: 'wh-1',
        name: 'CI Pipeline',
        status: 'revoked',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        revoked_at: '2026-01-01T01:00:00Z',
      };
      const output = formatWebhookDetail(webhook);
      expect(output).toContain('Webhook:     wh-1');
      expect(output).toContain('Name:        CI Pipeline');
      expect(output).toContain('Status:      revoked');
      expect(output).toContain('Revoked:     2026-01-01T01:00:00Z');
    });

    test('omits revoked_at when null', () => {
      const webhook: WebhookDetail = {
        webhook_id: 'wh-1',
        name: 'CI Pipeline',
        status: 'active',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        revoked_at: null,
      };
      const output = formatWebhookDetail(webhook);
      expect(output).not.toContain('Revoked:');
    });
  });

  describe('formatJson', () => {
    test('returns pretty-printed JSON', () => {
      const data = { task_id: 'abc' };
      expect(formatJson(data)).toBe(JSON.stringify(data, null, 2));
    });
  });
});
