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
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { GetMicrovmCommand, RunMicrovmCommand, type RunMicrovmCommandInput } from '@aws-sdk/client-lambda-microvms';
import { connectMicrovm, listWorkers, safeError, stopWorker } from './microvm-live-support';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'execute': { type: 'boolean', default: false },
      'account': { type: 'string' },
      'region': { type: 'string' },
      'stack': { type: 'string' },
      'image-version': { type: 'string' },
      'output': { type: 'string' },
    },
  });
  if (!values.execute) {
    process.stdout.write(`${JSON.stringify({
      cases: ['simultaneous-identical', 'changed-parameters', 'replay-after-termination', 'replay-at-30-130-305-seconds'],
      effects: 'Disposable NO_INGRESS workers with rejected startup input; no S3/task rows; maximum lifetime 180 seconds',
    })}\n`);
    return;
  }
  for (const key of ['account', 'region', 'stack', 'image-version', 'output'] as const) assert(values[key], `--${key} is required`);
  const target = { account: values.account!, region: values.region!, stack: values.stack!, imageVersion: values['image-version']! };
  const live = await connectMicrovm(target);
  const directory = values.output!;
  await mkdir(directory, { mode: 0o700 });
  const before = await listWorkers(live.mv, live.image);
  const runId = `p2-replay-${randomUUID()}`;
  const request: RunMicrovmCommandInput = {
    imageIdentifier: live.image,
    imageVersion: target.imageVersion,
    executionRoleArn: live.executionRole,
    ingressNetworkConnectors: live.ingress,
    egressNetworkConnectors: live.egress,
    logging: { cloudWatch: { logGroup: live.logGroup } },
    // Missing v2 reference: guaranteed rejection before S3/config/pipeline.
    runHookPayload: JSON.stringify({ probe: runId }),
    maximumDurationInSeconds: 180,
    clientToken: runId,
  };
  await writeFile(join(directory, 'context.json'), JSON.stringify({
    ...target,
    runId,
    stackId: live.stackId,
    request,
    beforeIds: before.map(w => w.microvmId),
    scope: 'Direct service idempotency; no coordinator or application retry code',
  }, null, 2), { mode: 0o600 });
  const results: Record<string, unknown>[] = [];
  const ids = new Set<string>();
  const started = Date.now();
  const report = async (row: Record<string, unknown>) => {
    const timed = { ...row, elapsedMs: Date.now() - started };
    results.push(timed);
    process.stdout.write(`${JSON.stringify(timed)}\n`);
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
  };
  const launch = async (label: string, input = request) => {
    try {
      const result = await live.mv.send(new RunMicrovmCommand(input));
      if (result.microvmId) ids.add(result.microvmId);
      await report({
        label,
        outcome: 'accepted',
        id: result.microvmId,
        state: result.state,
        requestId: result.$metadata.requestId,
        duration: result.maximumDurationInSeconds,
        requestFingerprint: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      });
      assert(result.microvmId, 'Run returned no handle');
      return result.microvmId;
    } catch (error) {
      await report({
        label,
        outcome: 'error',
        error: safeError(error),
        requestId: (error as { $metadata?: { requestId?: string } }).$metadata?.requestId,
      });
      throw error;
    }
  };
  try {
    const simultaneous = await Promise.allSettled([launch('simultaneous-a'), launch('simultaneous-b')]);
    const successes = simultaneous.filter(r => r.status === 'fulfilled');
    assert(successes.length, 'Neither simultaneous request succeeded');
    assert.equal(ids.size, 1, 'Identical requests created different workers');
    for (const rejected of simultaneous.filter(r => r.status === 'rejected')) {
      assert.equal((rejected.reason as { name: string }).name, 'ConflictException', 'Unexpected simultaneous failure');
    }
    const id = [...ids][0]!;
    assert.equal(await launch('immediate-replay'), id);
    // Observe whether AWS rejects changed parameters or returns the existing
    // worker. Either way it must not create a second worker for this token.
    try {
      assert.equal(await launch('changed-duration', { ...request, maximumDurationInSeconds: 181 }), id);
      await report({ label: 'changed-parameters', outcome: 'existing-worker-returned' });
    } catch (error) {
      assert.equal((error as { name: string }).name, 'ValidationException', 'Unexpected changed-request failure');
      assert.match((error as Error).message, /clientToken was used with different request parameters/);
      await report({ label: 'changed-parameters', outcome: 'conflict-rejected' });
    }
    const state = await live.mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
    assert.equal(state.maximumDurationInSeconds, 180, 'Changed request mutated the original worker');
    // Give the intentionally invalid startup hook time to reject on its own.
    for (let i = 0; i < 30; i++) {
      const current = await live.mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
      if (current.state === 'TERMINATED') {
        assert(current.stateReason?.includes('HTTP status 400'), 'Worker did not reject the invalid startup input');
        await report({ label: 'hook-rejected', id, state: current.state, reason: current.stateReason });
        break;
      }
      assert(i < 29, 'Worker did not terminate after startup rejection');
      await delay(2_000);
    }
    assert.equal(await launch('replay-after-termination'), id);
    for (const seconds of [30, 130, 305]) {
      await report({ label: 'waiting-for-replay', seconds });
      while (Date.now() - started < seconds * 1_000) {
        await delay(Math.min(10_000, seconds * 1_000 - (Date.now() - started)));
      }
      assert.equal(await launch(`replay-at-${seconds}s`), id);
    }
    assert.equal(ids.size, 1);
    await report({ stage: 'passed', boundedRetentionEvidenceSeconds: 305, id });
  } finally {
    const cleanup = await Promise.allSettled([...ids].map(id => stopWorker(live.mv, id)));
    const after = await listWorkers(live.mv, live.image);
    const unaccounted = after.filter(w => !before.some(b => b.microvmId === w.microvmId) && !ids.has(w.microvmId!));
    await report({
      stage: 'cleanup',
      knownIds: [...ids],
      cleanup: cleanup.map((r, i) => ({
        id: [...ids][i], confirmed: r.status === 'fulfilled', ...(r.status === 'rejected' && { error: safeError(r.reason) }),
      })),
      unaccountedIds: unaccounted.map(w => w.microvmId),
    });
    assert(cleanup.every(r => r.status === 'fulfilled'), 'Cleanup incomplete');
    // Unknown rows can belong to a concurrent caller: report, never delete them.
    assert.equal(unaccounted.length, 0, 'Another worker appeared during this probe; attribution needs review');
  }
}

main().catch(error => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
