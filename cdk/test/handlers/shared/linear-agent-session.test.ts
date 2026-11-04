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

jest.mock('../../../src/handlers/shared/linear-oauth-resolver', () => ({
  resolveLinearOauthToken: jest.fn(),
}));

import {
  addAgentSessionExternalUrl,
  agentSessionIdempotencyKey,
  buildAgentSessionTaskDescription,
  emitAgentActivity,
  fetchAgentSessionIssue,
} from '../../../src/handlers/shared/linear-agent-session';
import {
  isHandledAgentSessionAction,
  isLinearAgentSessionsEnabled,
  parseAgentSessionEvent,
} from '../../../src/handlers/shared/linear-agent-session-event';
import { MAX_TASK_DESCRIPTION_LENGTH } from '../../../src/handlers/shared/validation';

const fetchMock = jest.fn();
(globalThis as any).fetch = fetchMock;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function sentBody(call = 0): { query: string; variables: Record<string, any> } {
  return JSON.parse(fetchMock.mock.calls[call][1].body);
}

beforeEach(() => fetchMock.mockReset());

describe('isLinearAgentSessionsEnabled', () => {
  const original = process.env.LINEAR_AGENT_SESSIONS_ENABLED;
  afterEach(() => { process.env.LINEAR_AGENT_SESSIONS_ENABLED = original; });

  test('only the literal "true" enables the channel', () => {
    process.env.LINEAR_AGENT_SESSIONS_ENABLED = 'true';
    expect(isLinearAgentSessionsEnabled()).toBe(true);
    for (const v of ['1', 'TRUE', 'yes', '']) {
      process.env.LINEAR_AGENT_SESSIONS_ENABLED = v;
      expect(isLinearAgentSessionsEnabled()).toBe(false);
    }
    delete process.env.LINEAR_AGENT_SESSIONS_ENABLED;
    expect(isLinearAgentSessionsEnabled()).toBe(false);
  });
});

describe('parseAgentSessionEvent', () => {
  const base = { type: 'AgentSessionEvent', organizationId: 'org-1', webhookTimestamp: 42 };

  test('created: creator is the actor, the mention comment is the directive', () => {
    expect(parseAgentSessionEvent({
      ...base,
      action: 'created',
      agentSession: { id: 's-1', issue: { id: 'i-1' }, creator: { id: 'u-1' }, comment: { body: '  do it  ' } },
      promptContext: '<issue/>',
    })).toEqual({
      action: 'created',
      sessionId: 's-1',
      workspaceId: 'org-1',
      issueId: 'i-1',
      actorId: 'u-1',
      directive: 'do it',
      stopRequested: false,
      deliveryId: 's-1',
      promptContext: '<issue/>',
    });
  });

  test('created: the @bgagent handle is stripped from the directive; a bare mention is empty', () => {
    const at = (body: string) => parseAgentSessionEvent({
      ...base, action: 'created', agentSession: { id: 's-1', issueId: 'i-1', comment: { body } },
    })?.directive;
    expect(at('@bgagent please add tests')).toBe('please add tests');
    expect(at('  @bgagent  ')).toBe('');
  });

  test('created by delegation has an empty directive and tolerates a blank promptContext', () => {
    const r = parseAgentSessionEvent({ ...base, action: 'created', agentSession: { id: 's-1', issueId: 'i-1' }, promptContext: '  ' });
    expect(r).toEqual(expect.objectContaining({ directive: '', actorId: null, promptContext: null }));
  });

  test('prompted: reads the activity body, author and stop signal', () => {
    expect(parseAgentSessionEvent({
      ...base,
      action: 'prompted',
      agentSession: { id: 's-1', issueId: 'i-1' },
      agentActivity: { id: 'a-1', user: { id: 'u-2' }, signal: 'stop', content: { type: 'prompt', body: 'halt' } },
    })).toEqual(expect.objectContaining({
      action: 'prompted', actorId: 'u-2', directive: 'halt', stopRequested: true, deliveryId: 'a-1',
    }));
  });

  test('prompted without an activity id falls back to a per-delivery id', () => {
    const r = parseAgentSessionEvent({
      ...base, action: 'prompted', agentSession: { id: 's-1', issueId: 'i-1' }, agentActivity: { body: 'x' },
    });
    expect(r?.deliveryId).toBe('s-1-42');
    expect(r?.directive).toBe('x');
  });

  test.each([
    ['wrong type', { type: 'Comment', action: 'created', organizationId: 'o', agentSession: { id: 's', issueId: 'i' } }],
    ['unhandled action', { ...base, action: 'deleted', agentSession: { id: 's', issueId: 'i' } }],
    ['no session id', { ...base, action: 'created', agentSession: { issueId: 'i' } }],
    ['no issue', { ...base, action: 'created', agentSession: { id: 's' } }],
    ['no workspace', { type: 'AgentSessionEvent', action: 'created', agentSession: { id: 's', issueId: 'i' } }],
  ])('returns null for %s', (_name, payload) => {
    expect(parseAgentSessionEvent(payload)).toBeNull();
  });

  test('isHandledAgentSessionAction', () => {
    expect(isHandledAgentSessionAction('created')).toBe(true);
    expect(isHandledAgentSessionAction('prompted')).toBe(true);
    expect(isHandledAgentSessionAction('updated')).toBe(false);
    expect(isHandledAgentSessionAction(undefined)).toBe(false);
  });
});

describe('agentSessionIdempotencyKey', () => {
  test('is per-delivery, sanitised, and capped at 128 chars', () => {
    const r = parseAgentSessionEvent({
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'o',
      agentSession: { id: 's', issueId: 'i' },
      agentActivity: { id: `a:b/c${'x'.repeat(200)}` },
    })!;
    const key = agentSessionIdempotencyKey(r);
    expect(key.startsWith('linear-session-prompted-abc')).toBe(true);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(key.length).toBe(128);
  });
});

describe('buildAgentSessionTaskDescription', () => {
  const issue = { id: 'i', identifier: 'ENG-1', title: 'Title', description: 'Body', projectId: null };

  test('directive, then issue, then session context', () => {
    expect(buildAgentSessionTaskDescription(issue, 'Do X', '<ctx/>'))
      .toBe('Do X\n\nENG-1: Title\n\nBody\n\n## Linear session context\n\n<ctx/>');
  });

  test('falls back to a generic heading', () => {
    expect(buildAgentSessionTaskDescription({ ...issue, identifier: null, title: null, description: null }, '', null))
      .toBe('Linear issue');
  });

  test('never exceeds the task description limit, truncating context first', () => {
    const out = buildAgentSessionTaskDescription(issue, 'Do X', 'c'.repeat(MAX_TASK_DESCRIPTION_LENGTH));
    expect(out.length).toBeLessThanOrEqual(MAX_TASK_DESCRIPTION_LENGTH);
    expect(out.startsWith('Do X\n\nENG-1: Title')).toBe(true);
    expect(out.endsWith('_(session context truncated)_')).toBe(true);
  });

  test('an over-long directive is hard-capped', () => {
    const out = buildAgentSessionTaskDescription(issue, 'd'.repeat(MAX_TASK_DESCRIPTION_LENGTH + 50), '<ctx/>');
    expect(out.length).toBe(MAX_TASK_DESCRIPTION_LENGTH);
  });
});

describe('GraphQL helpers', () => {
  test('emitAgentActivity sends the typed content with the bearer token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { agentActivityCreate: { success: true } } }));
    await expect(emitAgentActivity('tok', 's-1', { type: 'response', body: 'done' })).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    const { query, variables } = sentBody();
    expect(query).toContain('agentActivityCreate');
    expect(variables).toEqual({ input: { agentSessionId: 's-1', content: { type: 'response', body: 'done' } } });
  });

  test('ephemeral is sent only for thought/action', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: {} }));
    await emitAgentActivity('tok', 's-1', { type: 'thought', body: 'x' }, { ephemeral: true });
    await emitAgentActivity('tok', 's-1', { type: 'error', body: 'x' }, { ephemeral: true });
    expect(sentBody(0).variables.input.ephemeral).toBe(true);
    expect(sentBody(1).variables.input).not.toHaveProperty('ephemeral');
  });

  test('5xx is retryable; GraphQL errors are not', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(emitAgentActivity('tok', 's', { type: 'thought', body: 'x' })).resolves.toEqual({ ok: false, retryable: true });
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'bad session' }] }));
    await expect(emitAgentActivity('tok', 's', { type: 'thought', body: 'x' })).resolves.toEqual({ ok: false, retryable: false });
  });

  test('addAgentSessionExternalUrl appends rather than replaces', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { agentSessionUpdate: { success: true } } }));
    await addAgentSessionExternalUrl('tok', 's-1', { label: 'Pull request #3', url: 'https://github.com/a/b/pull/3' });
    expect(sentBody().variables).toEqual({
      id: 's-1',
      input: { addedExternalUrls: [{ label: 'Pull request #3', url: 'https://github.com/a/b/pull/3' }] },
    });
  });

  test('fetchAgentSessionIssue maps the project id and distinguishes absent from failed', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { issue: { id: 'i-1', identifier: 'ENG-1', title: 'T', description: null, project: { id: 'p-1' } } },
    }));
    await expect(fetchAgentSessionIssue('tok', 'i-1')).resolves.toEqual({
      ok: true, value: { id: 'i-1', identifier: 'ENG-1', title: 'T', description: null, projectId: 'p-1' },
    });

    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { issue: null } }));
    await expect(fetchAgentSessionIssue('tok', 'i-1')).resolves.toEqual({ ok: false, absent: true });

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    const failed = await fetchAgentSessionIssue('tok', 'i-1');
    expect(failed.ok).toBe(false);
    expect('error' in failed).toBe(true);
  });
});
