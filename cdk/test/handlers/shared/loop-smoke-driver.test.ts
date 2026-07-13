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

import { verifyLoopSmoke } from '../../../src/handlers/shared/loop-smoke-assert';
import {
  buildLoopSmokeInput,
  parsePrUrl,
  parseSubmitOutput,
  parseWatchNdjson,
} from '../../../src/handlers/shared/loop-smoke-driver';

describe('parseSubmitOutput', () => {
  it('parses a pretty-printed TaskDetail blob (formatJson output)', () => {
    const stdout = JSON.stringify(
      { task_id: '01ABC', status: 'COMPLETED', pr_url: 'https://github.com/o/r/pull/7' },
      null,
      2,
    );
    const r = parseSubmitOutput(stdout);
    expect(r).toEqual({
      taskId: '01ABC',
      status: 'COMPLETED',
      prUrl: 'https://github.com/o/r/pull/7',
    });
  });

  it('tolerates surrounding whitespace and missing pr_url', () => {
    const r = parseSubmitOutput('\n  {"task_id":"01X","status":"SUBMITTED"}  \n');
    expect(r.taskId).toBe('01X');
    expect(r.prUrl).toBeNull();
  });

  it('throws on empty stdout', () => {
    expect(() => parseSubmitOutput('   ')).toThrow(/no stdout/);
  });

  it('throws on non-JSON stdout (e.g. text mode by mistake)', () => {
    expect(() => parseSubmitOutput('Task 01X submitted (SUBMITTED)')).toThrow(/not valid JSON/);
  });

  it('throws when JSON has no task_id', () => {
    expect(() => parseSubmitOutput('{"status":"SUBMITTED"}')).toThrow(/no task_id/);
  });
});

describe('parseWatchNdjson', () => {
  it('parses one event per line, preserving order', () => {
    const stdout = [
      '{"event_id":"1","event_type":"task_created","metadata":{}}',
      '{"event_id":"2","event_type":"session_started","metadata":{}}',
      '{"event_id":"3","event_type":"agent_milestone","metadata":{"milestone":"pr_created","details":"u"}}',
    ].join('\n');
    const events = parseWatchNdjson(stdout);
    expect(events.map((e) => e.event_type)).toEqual([
      'task_created',
      'session_started',
      'agent_milestone',
    ]);
    expect(events[2].metadata?.milestone).toBe('pr_created');
  });

  it('skips blank lines and a trailing newline', () => {
    const stdout = '\n{"event_id":"1","event_type":"task_created"}\n\n';
    expect(parseWatchNdjson(stdout)).toHaveLength(1);
  });

  it('skips a stray non-JSON line without crashing (defensive vs stderr bleed)', () => {
    const stdout = [
      '{"event_id":"1","event_type":"task_created"}',
      '[info] connected to api', // not JSON — must be skipped
      '{"event_id":"2","event_type":"task_completed"}',
    ].join('\n');
    const events = parseWatchNdjson(stdout);
    expect(events.map((e) => e.event_type)).toEqual(['task_created', 'task_completed']);
  });

  it('ignores JSON lines that lack an event_type', () => {
    const stdout = '{"foo":"bar"}\n{"event_type":"task_created"}';
    expect(parseWatchNdjson(stdout)).toHaveLength(1);
  });

  it('returns [] for empty stdout', () => {
    expect(parseWatchNdjson('')).toEqual([]);
  });
});

describe('parsePrUrl', () => {
  it('parses owner/repo/number from a PR URL', () => {
    expect(parsePrUrl('https://github.com/isadeks/sample-x/pull/38')).toEqual({
      owner: 'isadeks',
      repo: 'sample-x',
      number: 38,
    });
  });

  it('tolerates a trailing slash / query / fragment', () => {
    expect(parsePrUrl('https://github.com/o/r/pull/9/files')?.number).toBe(9);
    expect(parsePrUrl('https://github.com/o/r/pull/9?diff=split')?.number).toBe(9);
  });

  it('returns null for null/undefined/empty', () => {
    expect(parsePrUrl(null)).toBeNull();
    expect(parsePrUrl(undefined)).toBeNull();
    expect(parsePrUrl('')).toBeNull();
  });

  it('returns null for a non-PR github url (e.g. an issue)', () => {
    expect(parsePrUrl('https://github.com/o/r/issues/9')).toBeNull();
  });
});

describe('buildLoopSmokeInput → verifyLoopSmoke (parse+verify seam)', () => {
  it('a healthy submit+watch parse verifies green', () => {
    const submit = parseSubmitOutput(
      JSON.stringify({ task_id: '01', status: 'COMPLETED', pr_url: 'https://github.com/o/r/pull/5' }),
    );
    const events = parseWatchNdjson(
      [
        '{"event_type":"task_created"}',
        '{"event_type":"hydration_complete"}',
        '{"event_type":"session_started"}',
        '{"event_type":"agent_milestone","metadata":{"milestone":"pr_created","details":"https://github.com/o/r/pull/5"}}',
        '{"event_type":"task_completed"}',
      ].join('\n'),
    );
    const input = buildLoopSmokeInput({
      events,
      finalStatus: submit.status,
      prUrl: submit.prUrl,
      prBaseBranch: 'linear-vercel',
      expectedBaseBranch: 'linear-vercel',
    });
    const r = verifyLoopSmoke(input);
    expect(r.ok).toBe(true);
    expect(r.prUrl).toBe('https://github.com/o/r/pull/5');
  });

  it('passes prBaseBranch through as null → base check SKIPs (not fails)', () => {
    const input = buildLoopSmokeInput({
      events: parseWatchNdjson(
        [
          '{"event_type":"task_created"}',
          '{"event_type":"hydration_complete"}',
          '{"event_type":"session_started"}',
          '{"event_type":"agent_milestone","metadata":{"milestone":"pr_created","details":"u"}}',
          '{"event_type":"task_completed"}',
        ].join('\n'),
      ),
      finalStatus: 'COMPLETED',
      prUrl: 'u',
      prBaseBranch: null,
      expectedBaseBranch: 'main',
    });
    const r = verifyLoopSmoke(input);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === 'pr:base_branch')!.status).toBe('skip');
  });
});
