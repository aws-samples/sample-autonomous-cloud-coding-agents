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
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { logger } from './logger';
import { makeClient } from './ua';
import constants from '../../../../contracts/constants.json';

export const PAYLOAD_BOOTSTRAP = constants.payload_bootstrap;
type Backend = 'ecs' | 'lambda-microvm';

export interface PayloadReference {
  version: number;
  task_id: string;
  bootstrap_s3_uri: string;
  payload_url: string;
  expires_at: number;
}

interface LaunchRecord {
  fingerprint: string;
  reference: PayloadReference;
}

let client: S3Client | undefined;
function s3(): S3Client {
  return client ??= makeClient(S3Client);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Never let SDK errors echo bearer URLs into task records or logs. */
export function redactPayloadUrls(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>\\]+/gi, url =>
    /X-Amz-/i.test(url) ? '[redacted payload URL]' : url);
}

async function readObject(bucket: string, key: string): Promise<string | undefined> {
  try {
    const response = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) throw new Error('PAYLOAD_BOOTSTRAP_UNREADABLE: empty object response');
    return await response.Body.transformToString();
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return undefined;
    throw error;
  }
}

/** Conditional creation, including recovery after a committed write loses its reply. */
async function createOnce(bucket: string, key: string, body: string): Promise<string> {
  try {
    await s3().send(new PutObjectCommand({
      Bucket: bucket, Key: key, Body: body, ContentType: 'application/json', IfNoneMatch: '*',
    }));
    return body;
  } catch (error) {
    const saved = await readObject(bucket, key);
    if (saved !== undefined) return saved;
    throw error;
  }
}

/**
 * Save a single-object capability outside the agent-readable task table.
 * Replays read the same launch.json; re-signing would change Run's request
 * while reusing its clientToken. The worker can read only bootstrap/* using
 * its own credentials, never payload.json or launch.json.
 */
export async function preparePayloadReference(input: {
  bucket: string;
  taskId: string;
  backend: Backend;
  payload: Record<string, unknown>;
  platformConfig?: Record<string, string>;
}): Promise<PayloadReference> {
  const { bucket, taskId, backend, payload } = input;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || payload.task_id !== taskId) {
    throw new Error('PAYLOAD_BOOTSTRAP_INVALID: task identity does not match the payload');
  }
  const manifest = canonical({
    version: PAYLOAD_BOOTSTRAP.version, backend, platform_config: input.platformConfig ?? {},
  });
  const manifestKey = `${PAYLOAD_BOOTSTRAP.manifest_prefix}${sha256(manifest)}.json`;
  const payloadBody = canonical({
    version: PAYLOAD_BOOTSTRAP.version,
    task_id: taskId,
    agent_payload: payload,
    platform_config: input.platformConfig ?? {},
  });
  if (Buffer.byteLength(manifest) > PAYLOAD_BOOTSTRAP.max_manifest_bytes
    || Buffer.byteLength(payloadBody) > PAYLOAD_BOOTSTRAP.max_payload_bytes) {
    throw new Error('PAYLOAD_BOOTSTRAP_TOO_LARGE: bootstrap manifest or task payload exceeds its byte limit');
  }
  const fingerprint = sha256(canonical({ bucket, backend, manifest, payloadBody }));
  const launchKey = `${taskId}/${PAYLOAD_BOOTSTRAP.launch_filename}`;
  const accept = (saved: string): PayloadReference => {
    const record = JSON.parse(saved) as LaunchRecord;
    if (record.fingerprint !== fingerprint || record.reference?.task_id !== taskId) {
      throw new Error('PAYLOAD_BOOTSTRAP_CONFLICT: task already has different launch instructions');
    }
    if (record.reference.expires_at <= Date.now()) {
      throw new Error('PAYLOAD_BOOTSTRAP_EXPIRED: inspect the existing launch; do not start a replacement task');
    }
    return record.reference;
  };

  // Refresh only identical, public deployment settings so bucket lifecycle
  // expiry cannot reap an old manifest just as a new task starts using it.
  await s3().send(new PutObjectCommand({
    Bucket: bucket, Key: manifestKey, Body: manifest, ContentType: 'application/json',
  }));
  const existing = await readObject(bucket, launchKey);
  if (existing !== undefined) return accept(existing);

  const payloadKey = `${taskId}/payload.json`;
  const savedPayload = await createOnce(bucket, payloadKey, payloadBody);
  if (savedPayload !== payloadBody) {
    throw new Error('PAYLOAD_BOOTSTRAP_CONFLICT: task already has different stored instructions');
  }
  const now = Date.now();
  const credentials = await s3().config.credentials();
  const lifetime = Math.min(
    PAYLOAD_BOOTSTRAP.url_ttl_seconds,
    credentials.expiration
      ? Math.floor((credentials.expiration.getTime() - now) / 1000)
      : PAYLOAD_BOOTSTRAP.url_ttl_seconds,
  );
  if (lifetime < PAYLOAD_BOOTSTRAP.minimum_url_lifetime_seconds) {
    throw new Error('PAYLOAD_BOOTSTRAP_CREDENTIALS_EXPIRING: refresh coordinator credentials before launch');
  }
  const url = await getSignedUrl(s3(), new GetObjectCommand({
    Bucket: bucket, Key: payloadKey,
  }), { expiresIn: lifetime });
  const reference: PayloadReference = {
    version: PAYLOAD_BOOTSTRAP.version,
    task_id: taskId,
    bootstrap_s3_uri: `s3://${bucket}/${manifestKey}`,
    payload_url: url,
    expires_at: now + lifetime * 1000,
  };
  const record = canonical({ fingerprint, reference });
  return accept(await createOnce(bucket, launchKey, record));
}

/** Delete both task instructions and their saved capability; shared manifests expire by lifecycle. */
export async function deletePayloadReference(bucket: string, taskId: string): Promise<void> {
  for (const filename of ['payload.json', PAYLOAD_BOOTSTRAP.launch_filename]) {
    try {
      await s3().send(new DeleteObjectCommand({ Bucket: bucket, Key: `${taskId}/${filename}` }));
    } catch (error) {
      logger.warn('Payload bootstrap cleanup failed (non-fatal)', {
        task_id: taskId, filename, error: (error as { name?: string }).name ?? 'UnknownError',
      });
    }
  }
}
