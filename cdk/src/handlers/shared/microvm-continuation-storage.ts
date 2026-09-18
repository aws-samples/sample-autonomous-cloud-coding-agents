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

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { canonicalJson } from './canonical-json';
import type { SessionControlOptions } from './compute-strategy';
import { CONTINUATION_IO_TIMEOUT_MS } from './microvm-continuation-timing';
import {
  CONTINUATION, type ContinuationLaunchReceipt, type ContinuationRecord, validAttemptId,
} from './microvm-continuation-types';
import { continuationEnabled } from './microvm-worker-lease';
import type { BlueprintConfig } from './repo-config';
import { makeClient, makeDocClient } from './ua';
import constants from '../../../../contracts/constants.json';
import { TERMINAL_STATUSES } from '../../constructs/task-status';

const ddb = makeDocClient();
let s3: S3Client | undefined;
function storage(): S3Client {
  return s3 ??= makeClient(S3Client);
}
const TABLE = process.env.TASK_TABLE_NAME!;
const MAX_BYTES = constants.payload_bootstrap.max_payload_bytes;

interface LaunchInputs {
  readonly version: number;
  readonly task_id: string;
  readonly user_id: string;
  readonly payload: Record<string, unknown>;
  readonly blueprint: BlueprintConfig;
  readonly orchestrator_version: string;
}

function canonical(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value));
}

function hash(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function readObject(key: string, versionId?: string, options?: SessionControlOptions) {
  const timeout = AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS);
  const signal = options?.abortSignal ? AbortSignal.any([options.abortSignal, timeout]) : timeout;
  const response = await storage().send(new GetObjectCommand({
    Bucket: process.env.CONTINUATION_BUCKET_NAME!,
    Key: key,
    ...(versionId && { VersionId: versionId }),
  }), { abortSignal: signal });
  if (!(response.Body instanceof Readable) || !response.ContentLength || response.ContentLength > MAX_BYTES
    || !response.VersionId || response.VersionId === 'null'
    || (versionId && response.VersionId !== versionId)) {
    if (response.Body instanceof Readable) response.Body.destroy();
    throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: saved object is incomplete or unversioned');
  }
  const stream = response.Body;
  const abort = () => { stream.destroy(new Error('MICROVM_CONTINUATION_STORAGE_TIMEOUT: download did not finish')); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      signal.throwIfAborted();
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > response.ContentLength || size > MAX_BYTES) {
        throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: download exceeded its declared size');
      }
      chunks.push(bytes);
    }
  } finally {
    signal.removeEventListener('abort', abort);
    stream.destroy();
  }
  const bytes = Buffer.concat(chunks, size);
  if (bytes.length !== response.ContentLength) {
    throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: launch object length changed');
  }
  return { bytes, versionId: response.VersionId };
}

/** Save exact hydrated inputs independently of the short-lived bootstrap URL. */
export async function saveContinuationLaunch(
  taskId: string, userId: string, payload: Record<string, unknown>, blueprint: BlueprintConfig,
): Promise<void> {
  if (!continuationEnabled()) return;
  const version = process.env.AWS_LAMBDA_FUNCTION_VERSION ?? '';
  if (!validAttemptId(taskId) || payload.task_id !== taskId || payload.user_id !== userId || !/^\d+$/.test(version)) {
    throw new Error('MICROVM_CONTINUATION_INPUT_INVALID: task identity or published coordinator version is missing');
  }
  const inputs: LaunchInputs = {
    version: CONTINUATION.version,
    task_id: taskId,
    user_id: userId,
    payload,
    blueprint,
    orchestrator_version: version,
  };
  const bytes = canonical(inputs);
  if (!bytes.length || bytes.length > MAX_BYTES) {
    throw new Error('MICROVM_CONTINUATION_INPUT_INVALID: launch inputs exceed the storage bound');
  }
  const sha256 = hash(bytes);
  const key = `${CONTINUATION.object_key_prefix}${taskId}/launch/${sha256}.json`;
  let putError: unknown;
  try {
    await storage().send(new PutObjectCommand({
      Bucket: process.env.CONTINUATION_BUCKET_NAME!,
      Key: key,
      Body: bytes,
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
      IfNoneMatch: '*',
    }), { abortSignal: AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS) });
  } catch (error) {
    putError = error;
  }
  // Read back even after a successful Put. This also recovers a lost reply or
  // an identical publication by a replay, without changing the version pointer.
  let stored: Awaited<ReturnType<typeof readObject>>;
  try {
    stored = await readObject(key);
  } catch (error) {
    throw putError ?? error;
  }
  if (!stored.bytes.equals(bytes)) {
    throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: launch readback does not match published bytes');
  }
  const receipt: ContinuationLaunchReceipt = {
    version: CONTINUATION.version,
    key,
    version_id: stored.versionId,
    sha256,
    size_bytes: bytes.length,
    orchestrator_version: version,
  };
  try {
    await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { task_id: taskId },
      UpdateExpression: 'SET continuation_launch = :receipt REMOVE #ttl',
      ConditionExpression: 'user_id = :user AND #status = :hydrating '
        + 'AND (attribute_not_exists(continuation_launch) OR continuation_launch = :receipt)',
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':receipt': receipt, ':user': userId, ':hydrating': 'HYDRATING' },
    }));
  } catch (error) {
    const current = await ddb.send(new GetCommand({
      TableName: TABLE, Key: { task_id: taskId }, ConsistentRead: true,
    }));
    if (current.Item?.user_id !== userId
      || !canonical(current.Item.continuation_launch ?? null).equals(canonical(receipt))) throw error;
  }
}

/** The task record pins the version; workers cannot choose or overwrite this pointer. */
export async function loadContinuationLaunch(
  taskId: string, userId: string, receipt: ContinuationLaunchReceipt,
): Promise<LaunchInputs> {
  if (!validAttemptId(taskId) || receipt?.version !== CONTINUATION.version
    || !/^[a-f0-9]{64}$/.test(receipt.sha256)
    || receipt.key !== `${CONTINUATION.object_key_prefix}${taskId}/launch/${receipt.sha256}.json`
    || !receipt.version_id || receipt.version_id === 'null'
    || !Number.isSafeInteger(receipt.size_bytes) || receipt.size_bytes <= 0 || receipt.size_bytes > MAX_BYTES
    || !/^\d+$/.test(receipt.orchestrator_version)) {
    throw new Error('MICROVM_CONTINUATION_INPUT_INVALID: saved launch receipt is invalid');
  }
  const stored = await readObject(receipt.key, receipt.version_id);
  if (stored.bytes.length !== receipt.size_bytes || hash(stored.bytes) !== receipt.sha256) {
    throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: saved launch checksum does not match');
  }
  const inputs = JSON.parse(stored.bytes.toString('utf8')) as LaunchInputs;
  if (!inputs || inputs.version !== CONTINUATION.version || inputs.task_id !== taskId || inputs.user_id !== userId
    || inputs.payload?.task_id !== taskId || inputs.payload.user_id !== userId
    || inputs.blueprint?.compute_type !== 'lambda-microvm'
    || inputs.orchestrator_version !== receipt.orchestrator_version) {
    throw new Error('MICROVM_CONTINUATION_INPUT_INVALID: saved launch belongs to a different task');
  }
  return inputs;
}

/** Confirm all acknowledged object versions before retiring the only worker. */
export async function verifyContinuationCheckpoint(record: ContinuationRecord, options?: SessionControlOptions): Promise<void> {
  const stored = await readObject(record.manifest.key, record.manifest.version_id, options);
  if (stored.bytes.length !== record.manifest.size_bytes || hash(stored.bytes) !== record.manifest.sha256) {
    throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: checkpoint manifest checksum does not match');
  }
  const manifest = JSON.parse(stored.bytes.toString('utf8'));
  if (!manifest || manifest.version !== CONTINUATION.version
    || !canonical(manifest.identity ?? null).equals(canonical(record.identity))) {
    throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: checkpoint manifest identity does not match');
  }
  const identity = record.identity;
  const prefix = `${CONTINUATION.object_key_prefix}${identity.task_id}/${identity.attempt_id}/${identity.request_id}/`;
  for (const object of [
    { receipt: manifest.conversation, prefix, suffix: '.json', limit: CONTINUATION.max_conversation_bytes },
    { receipt: manifest.workspace, prefix: `${prefix}workspace/`, suffix: '.tar', limit: CONTINUATION.max_workspace_bytes },
  ]) {
    const receipt = object.receipt;
    if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.sha256)
      || receipt.key !== `${object.prefix}${receipt.sha256}${object.suffix}`
      || typeof receipt.version_id !== 'string' || !receipt.version_id || receipt.version_id === 'null'
      || !Number.isSafeInteger(receipt.size_bytes) || receipt.size_bytes <= 0 || receipt.size_bytes > object.limit) {
      throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: checkpoint contains an invalid object receipt');
    }
    const response = await storage().send(new HeadObjectCommand({
      Bucket: process.env.CONTINUATION_BUCKET_NAME!,
      Key: receipt.key,
      VersionId: receipt.version_id,
      ChecksumMode: 'ENABLED',
    }), {
      abortSignal: options?.abortSignal
        ? AbortSignal.any([options.abortSignal, AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS)])
        : AbortSignal.timeout(CONTINUATION_IO_TIMEOUT_MS),
    });
    if (response.VersionId !== receipt.version_id || response.ContentLength !== receipt.size_bytes
      || response.ChecksumSHA256 !== Buffer.from(receipt.sha256, 'hex').toString('base64')) {
      throw new Error('MICROVM_CONTINUATION_STORAGE_INVALID: checkpoint object version, length or checksum does not match');
    }
  }
}

/**
 * Called only after the last worker is confirmed stopped. Remove every version,
 * including superseded checkpoints, before clearing the task's cleanup marker.
 * Active records have no object expiry: a pending answer can outlive a worker.
 */
export async function deleteClosedTaskContinuations(
  taskId: string, userId: string, options: SessionControlOptions,
): Promise<void> {
  if (!validAttemptId(taskId)) throw new Error('MICROVM_CONTINUATION_CLEANUP_INVALID');
  const current = await ddb.send(new GetCommand({
    TableName: TABLE, Key: { task_id: taskId }, ConsistentRead: true,
  }), options);
  if (current.Item?.user_id !== userId || !TERMINAL_STATUSES.includes(current.Item.status)) return;
  const prefix = `${CONTINUATION.object_key_prefix}${taskId}/`;
  // Always list from the start after deleting a page. No cursor can skip a
  // version whose neighbour was removed in the preceding batch.
  while (true) {
    options.abortSignal?.throwIfAborted();
    const page = await storage().send(new ListObjectVersionsCommand({
      Bucket: process.env.CONTINUATION_BUCKET_NAME!, Prefix: prefix, MaxKeys: 1000,
    }), options);
    const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(object => {
      if (!object.Key?.startsWith(prefix) || !object.VersionId) {
        throw new Error('MICROVM_CONTINUATION_CLEANUP_INVALID: unexpected object identity');
      }
      return { Key: object.Key, VersionId: object.VersionId };
    });
    if (!objects.length) break;
    const removed = await storage().send(new DeleteObjectsCommand({
      Bucket: process.env.CONTINUATION_BUCKET_NAME!, Delete: { Objects: objects, Quiet: true },
    }), options);
    if (removed.Errors?.length) throw new Error('MICROVM_CONTINUATION_CLEANUP_FAILED: object versions remain');
  }
  await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { task_id: taskId },
    UpdateExpression: 'SET continuation_cleanup_at = :now REMOVE continuation, continuation_launch',
    ConditionExpression: 'user_id = :user AND #status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':user': userId, ':status': current.Item.status, ':now': new Date().toISOString() },
  }), options);
}
