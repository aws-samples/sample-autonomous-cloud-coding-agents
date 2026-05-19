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
 * EventLine renders both unwrapped (mock-fixture) and wrapped
 * (`agent_milestone` + `metadata.milestone`) approval events. These
 * tests assert the IMPL-26 user-visible-timeout milestones (Fix 4)
 * are surfaced as readable strings rather than raw event_type names —
 * the TUI gap that motivated this change.
 */

import { render } from 'ink-testing-library';
import EventLine from '../../src/tui/components/EventLine';
import type { TaskEvent } from '../../src/tui/data';

function makeEvent(partial: Partial<TaskEvent> & Pick<TaskEvent, 'event_type' | 'metadata'>): TaskEvent {
  return {
    event_id: partial.event_id ?? 'evt_01',
    timestamp: partial.timestamp ?? '2026-05-19T14:00:00Z',
    event_type: partial.event_type,
    metadata: partial.metadata,
  };
}

describe('EventLine — Cedar HITL milestones', () => {
  it('renders approval_timeout_capped from agent_milestone wrapper with requested → effective', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_timeout_capped',
        request_id: 'req_xyz',
        requested_timeout_s: 600,
        effective_timeout_s: 300,
        reason: 'rule_annotation',
        matching_rule_ids: ['write_credentials'],
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Timeout capped: 600s → 300s');
    expect(frame).toContain('rule_annotation');
    expect(frame).toContain('write_credentials');
    unmount();
  });

  it('renders approval_ceiling_shrinking with usable lifetime budget', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_ceiling_shrinking',
        request_id: 'req_xyz',
        maxLifetime_remaining_s: 1200,
        cleanup_margin_s: 200,
        task_default_timeout_s: 300,
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Approval window shrinking');
    expect(frame).toContain('1000s'); // 1200 - 200
    unmount();
  });

  it('renders approval_cap_exceeded as a task-halted signal', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_cap_exceeded',
        request_id: 'req_xyz',
        count: 50,
        cap: 50,
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Approval cap reached: 50/50');
    expect(frame).toContain('task halted');
    unmount();
  });

  it('renders approval_rate_limit_exceeded with rate vs limit', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_rate_limit_exceeded',
        request_id: 'req_xyz',
        rate: 25,
        limit: 10,
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    expect(lastFrame() ?? '').toContain('Approval rate limit: 25/min > 10/min');
    unmount();
  });

  it('renders approval_poll_degraded with consecutive-failure count', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_poll_degraded',
        request_id: 'req_xyz',
        consecutive_failures: 3,
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    expect(lastFrame() ?? '').toContain('Approval polling degraded');
    expect(lastFrame() ?? '').toContain('3 consecutive failures');
    unmount();
  });

  it('renders approval_late_win with outcome + reason', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_late_win',
        request_id: 'req_xyz',
        outcome: 'APPROVED',
        reason: 'user decision beat agent timer',
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Late decision won');
    expect(frame).toContain('APPROVED');
    unmount();
  });

  it('renders pre_approvals_loaded with scope previews', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'pre_approvals_loaded',
        count: 2,
        scopes: ['tool_type:Bash', 'rule:file_edit_gate'],
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pre-approvals loaded: 2 scopes');
    expect(frame).toContain('tool_type:Bash');
    expect(frame).toContain('rule:file_edit_gate');
    unmount();
  });

  it('renders approval_write_failed with truncated error', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_write_failed',
        request_id: null,
        error: 'TransactWriteItems: ConditionalCheckFailedException',
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    expect(lastFrame() ?? '').toContain('Approval write failed');
    unmount();
  });

  it('renders unwrapped mock-fixture approval_timeout_capped identically to wrapped form', () => {
    const event = makeEvent({
      event_type: 'approval_timeout_capped',
      metadata: {
        request_id: 'req_xyz',
        requested_timeout_s: 600,
        effective_timeout_s: 300,
        reason: 'maxLifetime_ceiling',
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Timeout capped: 600s → 300s');
    expect(frame).toContain('maxLifetime_ceiling');
    unmount();
  });

  it('falls back gracefully on unknown milestone sub-name', () => {
    const event = makeEvent({
      event_type: 'agent_milestone',
      metadata: {
        milestone: 'approval_future_milestone',
        details: 'something new',
      },
    });
    const { lastFrame, unmount } = render(<EventLine event={event} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('approval_future_milestone');
    expect(frame).toContain('something new');
    unmount();
  });
});
