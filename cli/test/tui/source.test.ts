/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

import type { PendingApprovalSummary } from '../../src/types';
import { enrichPendingApproval } from '../../src/tui/api/source';

describe('enrichPendingApproval', () => {
  const base: PendingApprovalSummary = {
    task_id: '01JBX7QNMR5PG4HW3FS8AY2K9',
    request_id: '01JBX7SSPK4RW0GM3KE7OY9C2U',
    tool_name: 'EditFile',
    tool_input_preview: 'src/api/users.ts',
    severity: 'high',
    reason: 'File write requires approval',
    created_at: '2026-05-12T00:00:00.000Z',
    timeout_s: 600,
    expires_at: '2026-05-12T00:10:00.000Z',
    matching_rule_ids: ['file_edit_gate'],
  };

  it('normalizes lowercase severity to UPPERCASE for display', () => {
    const repoMap = new Map<string, string>([[base.task_id, 'aws-samples/foo']]);
    const descMap = new Map<string, string | null>([[base.task_id, 'do a thing']]);
    const enriched = enrichPendingApproval(base, repoMap, descMap);
    expect(enriched.severity).toBe('HIGH');
    expect(enriched.repo).toBe('aws-samples/foo');
    expect(enriched.task_description).toBe('do a thing');
  });

  it('defaults to MEDIUM on unknown severity', () => {
    const enriched = enrichPendingApproval(
      { ...base, severity: 'extreme' as unknown as PendingApprovalSummary['severity'] },
      new Map(),
      new Map(),
    );
    expect(enriched.severity).toBe('MEDIUM');
  });

  it('falls back to "(unknown)" repo and empty description when not indexed', () => {
    const enriched = enrichPendingApproval(base, new Map(), new Map());
    expect(enriched.repo).toBe('(unknown)');
    expect(enriched.task_description).toBe('');
  });

  it('preserves matching_rule_ids and expires_at unchanged', () => {
    const enriched = enrichPendingApproval(base, new Map(), new Map());
    expect(enriched.matching_rule_ids).toEqual(['file_edit_gate']);
    expect(enriched.expires_at).toBe('2026-05-12T00:10:00.000Z');
    expect(enriched.timeout_s).toBe(600);
  });
});
