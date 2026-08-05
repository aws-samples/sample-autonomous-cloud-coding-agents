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

import { fetchJiraSubIssueGraph } from '../../../src/handlers/shared/jira-subissue-fetch';

jest.mock('../../../src/handlers/shared/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function jiraIssue(
  id: string,
  key: string,
  links: readonly Record<string, unknown>[] = [],
  projectKey = 'ENG',
): Record<string, unknown> {
  return {
    id,
    key,
    fields: {
      summary: `Work on ${key}`,
      description: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `Scope for ${key}` }] }],
      },
      project: { key: projectKey },
      issuelinks: links,
    },
  };
}

describe('fetchJiraSubIssueGraph', () => {
  test('returns no_children for an empty Jira search', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({ issues: [], isLast: true }));

    await expect(fetchJiraSubIssueGraph('token', 'cloud-1', 'ENG-1', {
      fetchImpl: fetchImpl as typeof fetch,
    })).resolves.toEqual({ kind: 'no_children' });
  });

  test('maps issue identity, project, description, and both blocker directions', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({
      issues: [
        jiraIssue('101', 'ENG-2', [{
          type: { outward: 'blocks', inward: 'is blocked by' },
          outwardIssue: { key: 'ENG-3' },
        }]),
        jiraIssue('102', 'ENG-3', [{
          type: { outward: 'blocks', inward: 'is blocked by' },
          inwardIssue: { key: 'ENG-2' },
        }]),
      ],
      isLast: true,
    }));

    const result = await fetchJiraSubIssueGraph('token', 'cloud-1', 'ENG-1', {
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.children).toEqual([
      expect.objectContaining({
        id: 'ENG-2',
        issue_id: '101',
        identifier: 'ENG-2',
        project_key: 'ENG',
        description: 'Scope for ENG-2',
        depends_on: [],
      }),
      expect.objectContaining({
        id: 'ENG-3',
        issue_id: '102',
        depends_on: ['ENG-2'],
      }),
    ]);
  });

  test('paginates with nextPageToken and preserves a cyclic graph for shared validation', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response({
        issues: [jiraIssue('101', 'ENG-2', [{
          type: { inward: 'is blocked by' },
          inwardIssue: { key: 'ENG-3' },
        }])],
        nextPageToken: 'page-2',
      }))
      .mockResolvedValueOnce(response({
        issues: [jiraIssue('102', 'ENG-3', [{
          type: { inward: 'is blocked by' },
          inwardIssue: { key: 'ENG-2' },
        }])],
        isLast: true,
      }));

    const result = await fetchJiraSubIssueGraph('token', 'cloud-1', 'ENG-1', {
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toContain('nextPageToken=page-2');
    expect(result).toMatchObject({
      kind: 'ok',
      children: [
        { id: 'ENG-2', depends_on: ['ENG-3'] },
        { id: 'ENG-3', depends_on: ['ENG-2'] },
      ],
    });
  });

  test('rejects malformed children before returning a graph', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({
      issues: [{ key: 'ENG-2', fields: { summary: 'Missing id', project: { key: 'ENG' } } }],
      isLast: true,
    }));

    const result = await fetchJiraSubIssueGraph('token', 'cloud-1', 'ENG-1', {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toEqual({
      kind: 'error',
      message: 'A Jira subtask is missing its key, project, or summary, so no orchestration was created.',
    });
  });

  test('rejects standard blockers outside the executable child set', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({
      issues: [jiraIssue('101', 'ENG-2', [{
        type: { inward: 'is blocked by' },
        inwardIssue: { key: 'ENG-999' },
      }])],
      isLast: true,
    }));

    const result = await fetchJiraSubIssueGraph('token', 'cloud-1', 'ENG-1', {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toEqual({
      kind: 'error',
      message: 'ENG-2 is blocked by ENG-999, which is not an executable subtask of ENG-1.',
    });
  });

  test('returns an actionable error on Jira auth/API failure', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response({}, 401));

    const result = await fetchJiraSubIssueGraph('token', 'cloud-1', 'ENG-1', {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toEqual({
      kind: 'error',
      message: 'Jira returned status 401 while reading authored subtasks.',
    });
  });

  test('rejects a repeated pagination token instead of looping', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response({ issues: [], nextPageToken: 'same' }))
      .mockResolvedValueOnce(response({ issues: [], nextPageToken: 'same' }));

    const result = await fetchJiraSubIssueGraph('token', 'cloud-1', 'ENG-1', {
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result).toEqual({
      kind: 'error',
      message: 'Jira returned a repeated pagination token while reading subtasks.',
    });
  });
});
