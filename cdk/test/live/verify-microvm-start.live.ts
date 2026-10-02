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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { GetMicrovmCommand } from '@aws-sdk/client-lambda-microvms';
import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { connectMicrovm, listWorkers, safeError, stopWorker } from './microvm-live-support';
import { runStartChild, type ProbeContext, type Trace } from './microvm-start-child';
import constants from '../../../contracts/constants.json';
import { TaskStatus } from '../../src/constructs/task-status';
import { deletePayloadReference, PAYLOAD_BOOTSTRAP, redactPayloadUrls } from '../../src/handlers/shared/payload-bootstrap';
import { makeClient, makeDocClient } from '../../src/handlers/shared/ua';

const CASES = [
  'control', 'lost-run-reply', 'crash-after-run', 'crash-after-payload', 'crash-after-launch',
  'lost-payload-reply', 'lost-launch-reply', 'lost-handle-reply', 'crash-after-handle',
  'handle-write-rejected', 'changed-input', 'canceled-handle', 'expired-receipt',
] as const;
type Case = typeof CASES[number];

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'execute': { type: 'boolean', default: false },
      'account': { type: 'string' },
      'region': { type: 'string' },
      'stack': { type: 'string' },
      'image-version': { type: 'string' },
      'output': { type: 'string' },
      'cases': { type: 'string', default: CASES.join(',') },
      'child-context': { type: 'string' },
      'fault': { type: 'string', default: 'none' },
      'action': { type: 'string', default: 'direct' },
      'trace': { type: 'string' },
    },
  });
  if (!values.execute) {
    process.stdout.write(`${JSON.stringify({ cases: CASES, effects: 'Synthetic S3 files/task rows and NO_INGRESS workers limited to 180 seconds; local process faults against AWS' })}\n`);
    return;
  }
  if (values['child-context']) {
    assert(values.trace);
    await runStartChild(JSON.parse(await readFile(values['child-context'], 'utf8')) as ProbeContext, values.fault!, values.action!, values.trace);
    return;
  }
  for (const key of ['account', 'region', 'stack', 'image-version', 'output'] as const) assert(values[key], `--${key} is required`);
  const cases = values.cases!.split(',') as Case[];
  assert(cases.every(c => CASES.includes(c)) && new Set(cases).size === cases.length);
  const target = { account: values.account!, region: values.region!, stack: values.stack!, imageVersion: values['image-version']! };
  const live = await connectMicrovm(target);
  const bucket = live.env.MICROVM_PAYLOAD_BUCKET!;
  const table = live.env.TASK_TABLE_NAME!;
  assert(bucket && table);
  const s3 = makeClient(S3Client, { region: target.region });
  const ddb = makeDocClient({ region: target.region });
  const directory = values.output!;
  await mkdir(directory, { mode: 0o700 });
  const runId = `p2-start-${randomUUID()}`;
  const environment: Record<string, string> = {
    ...Object.fromEntries(Object.values(constants.microvm_platform_config.env_by_key).map(name => [name, ''])),
    AWS_REGION: target.region,
    AWS_DEFAULT_REGION: target.region,
    AWS_MAX_ATTEMPTS: '1',
    TASK_TABLE_NAME: table,
    TASK_EVENTS_TABLE_NAME: `${runId}-events`,
    // Nonempty for the producer, deliberately malformed for guest validation.
    // The guest rejects this before installing config, fetching secrets or work.
    AGENT_SESSION_ROLE_ARN: 'synthetic-invalid-role',
    GITHUB_TOKEN_SECRET_ARN: `arn:aws:secretsmanager:${target.region}:${target.account}:secret:synthetic`,
    LOG_GROUP_NAME: runId,
    MICROVM_IMAGE_IDENTIFIER: live.image,
    MICROVM_IMAGE_VERSION: target.imageVersion,
    MICROVM_PAYLOAD_BUCKET: bucket,
    MICROVM_EXECUTION_ROLE_ARN: live.executionRole,
    MICROVM_INGRESS_CONNECTOR_ARNS: live.ingress.join(','),
    MICROVM_EGRESS_CONNECTOR_ARNS: live.egress.join(','),
  };
  const config = Object.fromEntries(Object.entries(constants.microvm_platform_config.env_by_key)
    .filter(([, name]) => environment[name]).map(([key, name]) => [key, environment[name]]));
  const canonical = JSON.stringify({ version: PAYLOAD_BOOTSTRAP.version, backend: 'lambda-microvm', platform_config: config },
    (_key, value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
  const manifestKey = `${PAYLOAD_BOOTSTRAP.manifest_prefix}${createHash('sha256').update(canonical).digest('hex')}.json`;
  const plans = cases.map(name => ({ name, taskId: randomUUID() }));
  const before = await listWorkers(live.mv, live.image);
  const readObject = async (key: string) => {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    assert(result.Body);
    return result.Body.transformToString();
  };
  const absent = async (key: string) => assert.rejects(readObject(key),
    (error: unknown) => (error as { name?: string }).name === 'NoSuchKey');
  await absent(manifestKey);
  await writeFile(join(directory, 'context.json'), JSON.stringify({
    ...target,
    runId,
    environment,
    manifestKey,
    plans,
    beforeIds: before.map(w => w.microvmId),
    scope: 'Production strategy/storage under operator credentials; local child faults; 180s lifetime and logging transport overrides',
  }, null, 2), { mode: 0o600 });
  const results: Record<string, unknown>[] = [];
  const report = async (row: Record<string, unknown>) => {
    results.push(row);
    process.stdout.write(`${JSON.stringify(row)}\n`);
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
  };
  const allTraces = async (): Promise<Trace[]> => {
    const traces: Trace[] = [];
    for (const path of (await readdir(directory)).filter(p => p.endsWith('.jsonl'))) {
      traces.push(...(await readFile(join(directory, path), 'utf8'))
        .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Trace));
    }
    return traces;
  };
  const task = async (id: string) => (await ddb.send(new GetCommand({
    TableName: table, Key: { task_id: id }, ConsistentRead: true,
  }))).Item;
  const cleanupTask = async (id: string) => {
    await deletePayloadReference(bucket, id);
    await absent(`${id}/payload.json`);
    await absent(`${id}/launch.json`);
    if (await task(id)) {
      await ddb.send(new DeleteCommand({
        TableName: table,
        Key: { task_id: id },
        ConditionExpression: 'user_id = :owner',
        ExpressionAttributeValues: { ':owner': runId },
      }));
    }
    assert.equal(await task(id), undefined);
  };
  let attempt = 0;
  const execute = async (context: ProbeContext, fault = 'none', action = 'direct') => {
    const contextFile = join(directory, `${context.taskId}.json`);
    await writeFile(contextFile, JSON.stringify(context, null, 2), { mode: 0o600 });
    const traceFile = join(directory, `${context.taskId}-${++attempt}.jsonl`);
    await writeFile(traceFile, '', { mode: 0o600 });
    const outcome = await new Promise<{ code: number | null; signal: string | null; output: string }>((resolve, reject) => {
      // Reuse the parent's resolved loader; npx may supply tsx from its cache.
      const processChild = spawn(process.execPath, [...process.execArgv, __filename, '--execute',
        '--child-context', contextFile, '--fault', fault, '--action', action, '--trace', traceFile],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 });
      let output = '';
      processChild.stdout.on('data', chunk => { output += String(chunk); });
      processChild.stderr.on('data', chunk => { output += String(chunk); });
      processChild.on('error', reject);
      processChild.on('close', (code, signal) => resolve({ code, signal, output }));
    });
    await writeFile(`${traceFile}.log`, redactPayloadUrls(outcome.output), { mode: 0o600 });
    assert.equal(outcome.signal, null, 'Child exceeded its time budget');
    const trace = (await readFile(traceFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Trace);
    await report({ stage: 'child', taskId: context.taskId, fault, action, code: outcome.code, trace });
    return { code: outcome.code, trace };
  };
  let failed = false;
  try {
    for (const { name, taskId } of plans) {
      await ddb.send(new PutCommand({
        TableName: table,
        Item: {
          task_id: taskId,
          user_id: runId,
          status: TaskStatus.HYDRATING,
          created_at: new Date().toISOString(),
          ttl: Math.floor(Date.now() / 1000) + 3_600,
        },
        ConditionExpression: 'attribute_not_exists(task_id)',
      }));
      const context = { taskId, userId: runId, environment, manifestKey, logGroup: live.logGroup };
      const initialFault = ['changed-input', 'expired-receipt'].includes(name) ? 'crash-after-run'
        : ['control', 'canceled-handle'].includes(name) ? 'none' : name;
      const first = await execute(context, initialFault, name === 'lost-run-reply' ? 'auto-retry' : 'direct');
      const traces = [...first.trace];
      if (initialFault !== 'none') assert(first.trace.some(t => t.kind === 'fault'), 'Requested fault was not injected');
      if (initialFault.startsWith('crash-')) {
        assert.equal(first.code, 73, 'Process did not reach the requested crash point');
        const beforeRetry = await task(taskId);
        assert(beforeRetry?.microvm_start);
        const storedPayload = await readObject(`${taskId}/payload.json`);
        if (name === 'changed-input') {
          const changed = await execute(context, 'none', 'changed');
          traces.push(...changed.trace);
          assert.equal(changed.code, 1);
          assert(changed.trace.some(t => t.error?.includes('MICROVM_START_INPUT_CHANGED')));
          assert(!changed.trace.some(t => t.kind === 'run-request'));
          assert.equal(await readObject(`${taskId}/payload.json`), storedPayload);
        }
        if (name === 'expired-receipt') {
          await report({ stage: 'waiting-for-receipt-expiry', taskId, expiresAt: beforeRetry.microvm_start.expiresAt });
          while (Date.now() <= beforeRetry.microvm_start.expiresAt) await delay(2_000);
          const expired = await execute(context);
          traces.push(...expired.trace);
          assert.equal(expired.code, 1);
          assert(expired.trace.some(t => t.error?.includes('MICROVM_START_OUTCOME_UNKNOWN')));
          assert(!expired.trace.some(t => t.kind === 'run-request'));
        } else {
          const recovered = await execute(context);
          traces.push(...recovered.trace);
          assert.equal(recovered.code, 0);
          if (name === 'crash-after-handle') assert(!recovered.trace.some(t => t.kind === 'run-request'));
          assert.equal(await readObject(`${taskId}/payload.json`), storedPayload);
        }
      } else if (name === 'handle-write-rejected') {
        assert.equal(first.code, 1);
        assert(first.trace.some(t => t.error?.includes('MICROVM_START_RECEIPT_SAVE_FAILED')));
        assert.equal((await task(taskId))?.microvm_start?.handle, undefined);
      } else {
        assert.equal(first.code, 0);
      }
      if (name === 'lost-run-reply') assert(first.trace.some(t => t.kind === 'result' && t.autoRetried));
      const launches = traces.filter(t => t.kind === 'run-success');
      const ids = new Set(launches.map(t => t.id));
      assert.equal(ids.size, 1, 'Application recovery created different workers');
      assert.equal(new Set(launches.map(t => t.fingerprint)).size, 1, 'Recovery changed the service request');
      const id = launches[0]!.id!;
      if (!['expired-receipt', 'handle-write-rejected'].includes(name)) {
        const saved = await task(taskId);
        assert.equal(saved?.microvm_start?.clientToken, taskId);
        assert.equal(saved?.microvm_start?.handle?.microvmId, id);
        assert.equal(saved?.session_id, id);
      }
      if (name === 'canceled-handle') {
        await ddb.send(new UpdateCommand({
          TableName: table,
          Key: { task_id: taskId },
          UpdateExpression: 'SET #s = :c',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':c': TaskStatus.CANCELLED },
        }));
        const closed = await execute(context);
        assert.equal(closed.code, 1);
        assert(closed.trace.some(t => t.error?.includes('MICROVM_START_TASK_CLOSED')));
        assert(!closed.trace.some(t => t.kind === 'run-request'));
      }
      for (let i = 0; i < 30; i++) {
        const observed = await live.mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
        if (observed.state === 'TERMINATED') break;
        assert(i < 29, 'Synthetic worker did not terminate');
        await delay(2_000);
      }
      // Rejected writes/cancellation may stop the VM before its startup hook.
      // Other cases must reach the malformed-anchor barrier, before installation.
      let messages: string[] = [];
      for (let i = 0; i < 30; i++) {
        const worker = await live.mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
        const day = worker.startedAt!.toISOString().slice(0, 10).replaceAll('-', '/');
        const logs = await live.aws<{ events?: { message?: string }[] }>([
          'logs', 'filter-log-events', '--log-group-name', live.logGroup,
          '--log-stream-name-prefix', `${day}[${target.imageVersion}]${id}`,
        ]);
        messages = (logs.events ?? []).map(e => e.message ?? '');
        assert(!messages.some(m => /X-Amz-(Signature|Credential|Security-Token)=/i.test(m)), 'Signed URL in logs');
        assert(!messages.some(m => /installed platform_config env|hook accepted task_id=/.test(m)), 'Pipeline unexpectedly started');
        if (['handle-write-rejected', 'canceled-handle'].includes(name)) break;
        if (messages.some(m => m.includes('must be a well-formed IAM role ARN'))) break;
        assert(i < 29, 'Expected guest configuration rejection not observed');
        await delay(2_000);
      }
      await writeFile(join(directory, `${id}.log`), messages.map(redactPayloadUrls).join(''), { mode: 0o600 });
      await cleanupTask(taskId);
      await report({
        stage: 'passed',
        case: name,
        taskId,
        id,
        runRequests: launches.length,
        requestFingerprint: launches[0]!.fingerprint,
        taskAndPayloadDeleted: true,
      });
    }
  } catch (error) {
    failed = true;
    await report({ stage: 'failed', error: safeError(error) });
  } finally {
    const ids = [...new Set((await allTraces()).filter(t => t.kind === 'run-success' && t.id).map(t => t.id!))];
    const workerCleanup = await Promise.allSettled(ids.map(id => stopWorker(live.mv, id)));
    const taskCleanup = await Promise.allSettled(plans.map(p => cleanupTask(p.taskId)));
    const manifestCleanup = await Promise.allSettled([s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: manifestKey })).then(() => absent(manifestKey))]);
    const cleanup = [...workerCleanup, ...taskCleanup, ...manifestCleanup];
    const after = await listWorkers(live.mv, live.image);
    const unaccounted = after.filter(w => !before.some(b => b.microvmId === w.microvmId) && !ids.includes(w.microvmId!));
    await report({
      stage: 'cleanup',
      ids,
      tasks: plans.map(p => p.taskId),
      confirmed: cleanup.every(r => r.status === 'fulfilled'),
      unaccountedIds: unaccounted.map(w => w.microvmId),
      errors: cleanup.filter(r => r.status === 'rejected').map(r => safeError(r.reason)),
    });
    if (cleanup.some(r => r.status === 'rejected') || unaccounted.length) failed = true;
  }
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
