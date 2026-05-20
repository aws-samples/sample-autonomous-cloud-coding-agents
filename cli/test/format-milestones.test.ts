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

/**
 * Shared milestone formatter — drives both the TUI Watch panel and
 * the plain `bgagent watch` CLI render. Tests assert the §11.1 user-
 * visible payloads (IMPL-26 surface promotion) come out identical
 * between the two surfaces, and that unknown sub-names degrade
 * gracefully so a future agent-side milestone never disappears from
 * either stream.
 */

import { formatMilestone } from '../src/format-milestones';

describe('formatMilestone — Cedar HITL §11.1', () => {
  it('renders approval_timeout_capped with requested → effective + rule_ids', () => {
    expect(
      formatMilestone({
        milestone: 'approval_timeout_capped',
        request_id: 'req_xyz',
        requested_timeout_s: 600,
        effective_timeout_s: 300,
        reason: 'rule_annotation',
        matching_rule_ids: ['write_credentials'],
      }),
    ).toBe('Timeout capped: 600s → 300s (rule_annotation (write_credentials))');
  });

  it('renders approval_ceiling_shrinking with usable lifetime budget', () => {
    expect(
      formatMilestone({
        milestone: 'approval_ceiling_shrinking',
        request_id: 'req_xyz',
        maxLifetime_remaining_s: 1200,
        cleanup_margin_s: 200,
        task_default_timeout_s: 300,
      }),
    ).toBe('Approval window shrinking — ~1000s of task lifetime left');
  });

  it('renders approval_cap_exceeded as a task-halted signal', () => {
    expect(
      formatMilestone({
        milestone: 'approval_cap_exceeded',
        request_id: 'req_xyz',
        count: 50,
        cap: 50,
      }),
    ).toBe('Approval cap reached: 50/50 — task halted');
  });

  it('renders approval_rate_limit_exceeded with rate vs limit', () => {
    expect(
      formatMilestone({
        milestone: 'approval_rate_limit_exceeded',
        request_id: 'req_xyz',
        rate: 25,
        limit: 10,
      }),
    ).toBe('Approval rate limit: 25/min > 10/min');
  });

  it('renders approval_poll_degraded with consecutive-failure count', () => {
    expect(
      formatMilestone({
        milestone: 'approval_poll_degraded',
        request_id: 'req_xyz',
        consecutive_failures: 3,
      }),
    ).toBe('Approval polling degraded — 3 consecutive failures');
  });

  it('renders approval_late_win with outcome + reason', () => {
    expect(
      formatMilestone({
        milestone: 'approval_late_win',
        request_id: 'req_xyz',
        outcome: 'APPROVED',
        reason: 'user decision beat agent timer',
      }),
    ).toBe('Late decision won: APPROVED (.._xyz) — user decision beat agent timer');
  });

  it('renders pre_approvals_loaded with scope previews when scopes present', () => {
    expect(
      formatMilestone({
        milestone: 'pre_approvals_loaded',
        count: 2,
        scopes: ['tool_type:Bash', 'rule:file_edit_gate'],
      }),
    ).toBe('Pre-approvals loaded: 2 scopes — tool_type:Bash, rule:file_edit_gate');
  });

  it('renders pre_approvals_loaded with explicit message on zero count', () => {
    expect(
      formatMilestone({
        milestone: 'pre_approvals_loaded',
        count: 0,
        scopes: [],
      }),
    ).toBe('No pre-approvals loaded');
    // This is the case that bit us in the live drive — `bgagent submit`
    // with no `--pre-approve` flags: the milestone fired but the CLI
    // watch rendered just `★ pre_approvals_loaded` with no detail.
    // Now both surfaces explicitly say "no pre-approvals loaded".
  });

  it('truncates a +N more suffix when more than 3 scopes are loaded', () => {
    expect(
      formatMilestone({
        milestone: 'pre_approvals_loaded',
        count: 5,
        scopes: ['a', 'b', 'c', 'd', 'e'],
      }),
    ).toBe('Pre-approvals loaded: 5 scopes — a, b, c, +2 more');
  });

  it('renders approval_requested with tool name + truncated input preview', () => {
    expect(
      formatMilestone({
        milestone: 'approval_requested',
        request_id: 'req_xyz',
        tool_name: 'Bash',
        input_preview: 'git push --force origin main',
        reason: 'force-push to main',
        severity: 'high',
        timeout_s: 600,
      }),
    ).toBe('APPROVAL NEEDED: Bash — git push --force origin main');
  });

  it('renders approval_granted with scope when present', () => {
    expect(
      formatMilestone({
        milestone: 'approval_granted',
        request_id: '01KS17GZBSKJ32X9C4MH6ZDJ1T',
        scope: 'tool_type:Bash',
        decided_at: '2026-05-19T23:00:00Z',
      }),
    ).toBe('Approved (..DJ1T) scope=tool_type:Bash');
  });

  it('renders approval_denied with reason when present', () => {
    expect(
      formatMilestone({
        milestone: 'approval_denied',
        request_id: 'req_zzz',
        reason: 'too risky for this branch',
        decided_at: '2026-05-19T23:01:00Z',
      }),
    ).toBe('Denied (.._zzz) — too risky for this branch');
  });

  it('renders approval_timed_out using effective_timeout_s when present', () => {
    expect(
      formatMilestone({
        milestone: 'approval_timed_out',
        request_id: 'req_zzz',
        timeout_s: 600,
        effective_timeout_s: 300,
      }),
    ).toBe('Timed out (.._zzz) after 300s');
  });

  it('renders approval_stranded with reconciler reason', () => {
    expect(
      formatMilestone({
        milestone: 'approval_stranded',
        request_id: 'req_zzz',
        age_s: 3600,
        reason: 'task evicted from runtime',
      }),
    ).toBe('Stranded (.._zzz) — reconciler: task evicted from runtime');
  });

  it('renders approval_write_failed with truncated error', () => {
    expect(
      formatMilestone({
        milestone: 'approval_write_failed',
        request_id: null,
        error: 'TransactWriteItems: ConditionalCheckFailedException',
      }),
    ).toContain('Approval write failed: ');
  });

  it('renders policy_decision (recent-decision-cache hit, IMPL-23)', () => {
    expect(
      formatMilestone({
        milestone: 'policy_decision',
        decision_source: 'recent_decision_cache',
        tool_name: 'Bash',
        cached_decision: 'denied',
      }),
    ).toBe('Policy cache hit: Bash → denied');
  });

  it('returns null for unknown milestone sub-names so caller falls back', () => {
    expect(
      formatMilestone({
        milestone: 'approval_future_milestone',
        details: 'something new',
      }),
    ).toBeNull();
  });

  it('returns null when no milestone key is present', () => {
    expect(formatMilestone({ details: 'just a generic milestone' })).toBeNull();
  });
});
