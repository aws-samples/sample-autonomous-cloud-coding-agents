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
import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { LambdaMicrovmsClient, RunMicrovmCommand, type RunMicrovmCommandOutput } from '@aws-sdk/client-lambda-microvms';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { safeError } from './microvm-live-support';

export interface ProbeContext {
  taskId: string;
  userId: string;
  environment: Record<string, string>;
  manifestKey: string;
  logGroup: string;
}
export interface Trace {
  kind: string;
  id?: string;
  fingerprint?: string;
  error?: string;
  autoRetried?: boolean;
  [key: string]: unknown;
}

/** SDK fault injection is confined to a fresh local process, never the deployment. */
export async function runStartChild(context: ProbeContext, fault: string, action: string, traceFile: string): Promise<void> {
  Object.assign(process.env, context.environment);
  const trace = async (row: Trace) => appendFile(traceFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  let injected = false;
  const inject = async (point: string) => {
    if (injected || ![`lost-${point}-reply`, `crash-after-${point}`].includes(fault)) return;
    injected = true;
    await trace({ kind: 'fault', point, fault });
    if (fault.startsWith('crash-')) process.exit(73);
    throw Object.assign(new Error(`Synthetic lost ${point} response after AWS success`), { name: 'TimeoutError' });
  };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies each actual client as this.
  const originalVmSend = LambdaMicrovmsClient.prototype.send;
  Object.defineProperty(LambdaMicrovmsClient.prototype, 'send', {
    value: async function(this: LambdaMicrovmsClient, command: RunMicrovmCommand) {
      if (!(command instanceof RunMicrovmCommand)) return Reflect.apply(originalVmSend, this, [command]);
      // The deterministic test transport uses 180s instead of 8h and adds logs.
      // Production hashing/receipt/payload/retry logic remains unchanged.
      command.input.maximumDurationInSeconds = 180;
      command.input.logging = { cloudWatch: { logGroup: context.logGroup } };
      const fingerprint = createHash('sha256').update(JSON.stringify(command.input)).digest('hex');
      await trace({ kind: 'run-request', fingerprint, clientToken: command.input.clientToken });
      const response = await Reflect.apply(originalVmSend, this, [command]) as RunMicrovmCommandOutput;
      await trace({ kind: 'run-success', id: response.microvmId, fingerprint, requestId: response.$metadata.requestId });
      await inject('run');
      return response;
    },
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies each actual client as this.
  const originalS3Send = S3Client.prototype.send;
  Object.defineProperty(S3Client.prototype, 'send', {
    value: async function(this: S3Client, command: PutObjectCommand) {
      if (!(command instanceof PutObjectCommand)) return Reflect.apply(originalS3Send, this, [command]);
      assert.equal(command.input.Bucket, context.environment.MICROVM_PAYLOAD_BUCKET);
      const key = command.input.Key!;
      assert([context.manifestKey, `${context.taskId}/payload.json`, `${context.taskId}/launch.json`].includes(key));
      const response = await Reflect.apply(originalS3Send, this, [command]);
      await trace({ kind: 's3-committed', key });
      if (key.endsWith('/payload.json')) await inject('payload');
      if (key.endsWith('/launch.json')) await inject('launch');
      return response;
    },
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Reflect.apply supplies each actual client as this.
  const originalDdbSend = DynamoDBDocumentClient.prototype.send;
  Object.defineProperty(DynamoDBDocumentClient.prototype, 'send', {
    value: async function(this: DynamoDBDocumentClient, command: UpdateCommand) {
      const handleWrite = command instanceof UpdateCommand && command.input.UpdateExpression?.includes('microvm_start.#handle');
      if (handleWrite && fault === 'handle-write-rejected') {
        await trace({ kind: 'fault', point: 'before-handle-write', fault });
        throw Object.assign(new Error('Synthetic denied handle write'), { name: 'AccessDeniedException' });
      }
      const response = await Reflect.apply(originalDdbSend, this, [command]);
      if (handleWrite) {
        await trace({ kind: 'handle-committed' });
        await inject('handle');
      }
      return response;
    },
  });
  // These production modules capture their environment at import time.
  const { LambdaMicrovmComputeStrategy } = await import('../../src/handlers/shared/strategies/lambda-microvm-strategy.js');
  const { startSessionWithRetry } = await import('../../src/handlers/shared/session-start-retry.js');
  const input = {
    taskId: context.taskId,
    userId: context.userId,
    payload: { task_id: context.taskId, description: action === 'changed' ? 'Changed synthetic instructions' : 'Synthetic recovery probe' },
    blueprintConfig: { compute_type: 'lambda-microvm' as const, runtime_arn: '' },
  };
  try {
    const strategy = new LambdaMicrovmComputeStrategy();
    const result = action === 'auto-retry'
      ? await startSessionWithRetry(strategy, input, {
        taskId: context.taskId,
        emitRetryEvent: async () => { await trace({ kind: 'retry-event' }); },
        logger: { warn: () => { /* Retry event and final result are captured above/below. */ } },
      })
      : { handle: await strategy.startSession(input), autoRetried: false };
    await trace({ kind: 'result', id: result.handle.sessionId, autoRetried: result.autoRetried });
  } catch (error) {
    await trace({ kind: 'application-error', error: safeError(error) });
    process.exitCode = 1;
  }
}
