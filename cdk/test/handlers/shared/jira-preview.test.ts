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
    finish: () => { task = { ...task, status: 'COMPLETED' }; },
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
  expect(jiraPreviewDocument(url, preview).content).toEqual([]);
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
  let release!: () => void;
  let started!: () => void;
  const atPut = new Promise<void>((resolve) => { started = resolve; });
  put.mockImplementationOnce(async () => {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    return { ok: true };
  });
  const heartbeat = f.update(status('Working', false));
  await atPut;
  if (!previewFirst) f.screenshot();
  await f.update(status('✅ Finished', true));
  release();
  await heartbeat;
  const body = JSON.stringify(put.mock.calls.at(-1)![3]);
  expect(body).toContain('✅ Finished');
  expect(body).toContain('Open screenshot');
  expect(body).not.toContain('Working');
});

test('a slow preview writer repairs a later terminal write', async () => {
  const f = fixture();
  await f.update(status('Working', false));
  f.screenshot();
  let release!: () => void;
  let started!: () => void;
  const atPut = new Promise<void>((resolve) => { started = resolve; });
  put.mockImplementationOnce(async () => {
    started();
    await new Promise<void>((resolve) => { release = resolve; });
    return { ok: true };
  });
  const delivering = f.update();
  await atPut;
  await f.update(status('❌ Failed', true));
  release();
  await delivering;
  expect(JSON.stringify(put.mock.calls.at(-1)![3])).toContain('❌ Failed');
  expect(JSON.stringify(put.mock.calls.at(-1)![3])).toContain('Open live preview');
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

test('Jira and persistence failures are best effort', async () => {
  const f = fixture();
  put.mockResolvedValueOnce({ ok: false, retryable: false });
  await expect(f.update()).resolves.toEqual({ ok: false, retryable: false });
  f.send.mockRejectedValueOnce(new Error('DDB unavailable'));
  await expect(f.update()).resolves.toEqual({ ok: false, retryable: true });
});
