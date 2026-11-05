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

import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildAdfDocument, updateIssueCommentAdf } from '../../../src/handlers/shared/jira-feedback';
import { jiraPreviewDocument, updateJiraIterationComment } from '../../../src/handlers/shared/jira-preview';
import type { TaskRecord } from '../../../src/handlers/shared/types';

jest.mock('../../../src/handlers/shared/jira-feedback', () => ({
  ...jest.requireActual('../../../src/handlers/shared/jira-feedback'),
  updateIssueCommentAdf: jest.fn(),
}));
const put = jest.mocked(updateIssueCommentAdf);
const ctx = { cloudId: 'cloud', registryTableName: 'registry' };
const shot = 'https://cdn.example.com/shot.png';
const preview = 'https://preview.example.com/a)](https://evil.example.com)';
const status = (text: string, terminal: boolean) => ({ body: buildAdfDocument([[{ text }]]), terminal });

function fixture() {
  let task = { task_id: 'task', status: 'RUNNING' } as TaskRecord;
  const send = jest.fn(async (command) => {
    if (command instanceof GetCommand) return { Item: structuredClone(task) };
    const value = command.input.ExpressionAttributeValues[':value'];
    if (!value.terminal && task.jira_iteration_status?.terminal) {
      throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
    }
    task = { ...task, jira_iteration_status: value };
    return {};
  });
  const ddb = { send } as unknown as DynamoDBDocumentClient;
  return {
    update: (value?: ReturnType<typeof status>) => updateJiraIterationComment(ddb, 'table', 'task', ctx, 'ENG-42', '123', value),
    screenshot: () => { task = { ...task, screenshot_url: shot, screenshot_preview_url: preview }; },
    finish: (metrics: Record<string, unknown> = {}) => { task = { ...task, ...metrics, status: 'COMPLETED' } as TaskRecord; },
    send,
  };
}

beforeEach(() => put.mockReset().mockResolvedValue({ ok: true }));

test('ADF uses explicit links, preserving the full URL without Markdown injection', () => {
  const doc = jiraPreviewDocument(shot, preview);
  const content = JSON.stringify(doc);
  expect(content).toContain('Open screenshot');
  expect(content).toContain('Open live preview');
  expect(content).toContain(preview);
  expect(content).not.toContain('mediaSingle');
});

test.each(['javascript:alert(1)', 'https://localhost/a', 'https://127.0.0.1/a'])('rejects untrusted links: %s', (url) => {
  expect(jiraPreviewDocument(url, preview)).toBeNull();
  expect(JSON.stringify(jiraPreviewDocument(shot, url))).not.toContain('Open live preview');
});

test('duplicate preview refreshes keep exactly one preview block', async () => {
  const f = fixture();
  await f.update(status('Working', false));
  f.screenshot();
  await f.update();
  await f.update();
  const body = JSON.stringify(put.mock.calls.at(-1)![3]);
  expect(body.match(/Open screenshot/g)).toHaveLength(1);
  expect(body).toContain('Working');
});

test.each([false, true])('a slow heartbeat repairs a terminal write with preview (preview first: %s)', async (previewFirst) => {
  const f = fixture();
  if (previewFirst) f.screenshot();
  const settled: string[] = [];
  put.mockImplementation(async (_ctx, _issue, _comment, body) => {
    settled.push(JSON.stringify(body));
    return { ok: true };
  });
  let release!: () => void;
  let started!: () => void;
  const atPut = new Promise<void>((resolve) => { started = resolve; });
  put.mockImplementationOnce(async (_ctx, _issue, _comment, body) => {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    settled.push(JSON.stringify(body));
    return { ok: true };
  });
  const heartbeat = f.update(status('Working', false));
  await atPut;
  if (!previewFirst) f.screenshot();
  await f.update(status('✅ Finished', true));
  release();
  await heartbeat;
  expect(put).toHaveBeenCalledTimes(3);
  const body = settled.at(-1)!;
  expect(body).toContain('✅ Finished');
  expect(body).toContain('Open screenshot');
  expect(body).not.toContain('Working');
});

test('a slow preview writer repairs a later terminal write', async () => {
  const f = fixture();
  await f.update(status('Working', false));
  f.screenshot();
  const settled: string[] = [];
  put.mockImplementation(async (_ctx, _issue, _comment, body) => {
    settled.push(JSON.stringify(body));
    return { ok: true };
  });
  let release!: () => void;
  let started!: () => void;
  const atPut = new Promise<void>((resolve) => { started = resolve; });
  put.mockImplementationOnce(async (_ctx, _issue, _comment, body) => {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    settled.push(JSON.stringify(body));
    return { ok: true };
  });
  const delivering = f.update();
  await atPut;
  await f.update(status('❌ Failed', true));
  release();
  await delivering;
  expect(put).toHaveBeenCalledTimes(4);
  expect(settled.at(-1)).toContain('❌ Failed');
  expect(settled.at(-1)).toContain('Open live preview');
});

test('late progress cannot replace a durable terminal body', async () => {
  const f = fixture();
  await f.update(status('✅ Finished', true));
  f.screenshot();
  await f.update(status('Working', false));
  expect(JSON.stringify(put.mock.calls.at(-1)![3])).toContain('✅ Finished');
});

test('a preview on an older terminal task renders its outcome', async () => {
  const f = fixture();
  f.finish();
  f.screenshot();
  await f.update();
  expect(JSON.stringify(put.mock.calls.at(-1)![3])).toContain('Task completed');
});

test('completed runtime metrics stored as strings do not block the saved terminal status or preview', async () => {
  const f = fixture();
  f.finish({ cost_usd: '0.20663065', turns_attempted: '12', duration_s: '69.3' });
  f.screenshot();
  await expect(f.update(status('✅ Finished — result posted below.', true))).resolves.toEqual({ ok: true });
  const body = JSON.stringify(put.mock.calls.at(-1)![3]);
  expect(body).toContain('✅ Finished');
  expect(body).toContain('Open screenshot');
  expect(body).toContain('Open live preview');
});

test('fallback status normalizes runtime metrics stored as strings', async () => {
  const f = fixture();
  await f.update(status('Working', false));
  f.finish({ cost_usd: '0.20663065', turns_attempted: '12', max_turns: '30', duration_s: '69.3' });
  f.screenshot();
  await expect(f.update()).resolves.toEqual({ ok: true });
  const body = JSON.stringify(put.mock.calls.at(-1)![3]);
  expect(body).toContain('Task completed');
  expect(body).toContain('$0.21');
  expect(body).toContain('12 / 30');
  expect(body).toContain('1m 9s');
  expect(body).toContain('Open screenshot');
  expect(body).not.toContain('Working');
});

test('malformed optional metrics do not prevent terminal feedback', async () => {
  const f = fixture();
  f.finish({ cost_usd: 'invalid', duration_s: 'NaN' });
  await expect(f.update()).resolves.toEqual({ ok: true });
  const body = JSON.stringify(put.mock.calls.at(-1)![3]);
  expect(body).toContain('Task completed');
  expect(body).toContain('cost: —');
  expect(body).toContain('duration: —');
});

test('Jira and persistence failures are best effort', async () => {
  const f = fixture();
  put.mockResolvedValueOnce({ ok: false, retryable: false });
  await expect(f.update()).resolves.toEqual({ ok: false, retryable: false });
  f.send.mockRejectedValueOnce(new Error('DDB unavailable'));
  await expect(f.update()).resolves.toEqual({ ok: false, retryable: true });
});

test('a missing task is non-retryable and never writes a comment', async () => {
  const f = fixture();
  f.send.mockResolvedValueOnce({} as never);
  await expect(f.update()).resolves.toEqual({ ok: false, retryable: false });
  expect(put).not.toHaveBeenCalled();
});

test('continuous concurrent changes do not turn successful PUTs into retryable failures', async () => {
  const f = fixture();
  let version = 0;
  f.send.mockImplementation(async () => ({
    Item: {
      task_id: 'task', status: 'RUNNING', jira_iteration_status: status(`Working ${version++}`, false),
    },
  }));
  await expect(f.update()).resolves.toEqual({ ok: true });
  expect(put).toHaveBeenCalledTimes(4);
});

test('a failed verification read after a successful PUT does not retry terminal delivery', async () => {
  const f = fixture();
  put.mockImplementationOnce(async () => {
    f.send.mockRejectedValueOnce(new Error('DDB unavailable'));
    return { ok: true };
  });
  await expect(f.update()).resolves.toEqual({ ok: true });
});

test('progress persistence protects terminal state and reads are strongly consistent', async () => {
  const f = fixture();
  await f.update(status('Working', false));
  const update = f.send.mock.calls[0][0].input;
  expect(update.ConditionExpression).toBe('attribute_exists(task_id) AND (attribute_not_exists(jira_iteration_status) OR jira_iteration_status.terminal = :false)');
  expect(update.ExpressionAttributeValues[':false']).toBe(false);
  const reads = f.send.mock.calls.filter(([command]) => command instanceof GetCommand);
  expect(reads).toHaveLength(2);
  for (const [command] of reads) expect(command.input.ConsistentRead).toBe(true);
});
