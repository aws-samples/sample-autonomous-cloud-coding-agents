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

// Runs against an ALREADY deployed image; no infrastructure/permission changes.
// Every synthetic payload deliberately fails before installing configuration or
// starting a pipeline. Signed URLs stay in memory. Never persist request bodies.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs, promisify } from 'node:util';
import { GetFunctionConfigurationCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  GetMicrovmCommand, GetMicrovmImageCommand, LambdaMicrovmsClient,
  RunMicrovmCommand, TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  deletePayloadReference, PAYLOAD_BOOTSTRAP, type PayloadReference, preparePayloadReference, redactPayloadUrls,
} from '../../src/handlers/shared/payload-bootstrap';
import { makeClient } from '../../src/handlers/shared/ua';

const CASES = [
  'valid-transport', 'wrong-task', 'wrong-config', 'bad-json',
  'bad-signature', 'expired-url', 'revoked-url', 'foreign-manifest',
  'wrong-path', 'bad-manifest-digest', 'large-payload',
] as const;
const command = promisify(execFile);
type Case = typeof CASES[number];
const EXPECTED: Record<Case, string> = {
  'valid-transport': 'platform_config is missing or blank for required key(s)',
  'wrong-task': 'downloaded payload does not belong to the referenced task',
  'wrong-config': 'payload configuration does not match the authenticated deployment manifest',
  'bad-json': 'task payload is not valid JSON',
  'bad-signature': 'task payload download returned HTTP 403',
  'expired-url': 'task payload download returned HTTP 403',
  'revoked-url': 'task payload download returned HTTP 404',
  'foreign-manifest': 'deployment manifest read failed (AccessDenied)',
  'wrong-path': 'payload reference must sign this task\'s exact S3 object',
  'bad-manifest-digest': 'deployment manifest digest does not match its key',
  'large-payload': 'platform_config is missing or blank for required key(s)',
};

function safeError(error: unknown): string {
  return redactPayloadUrls(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
}

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
    },
  });
  const cases = values.cases!.split(',') as Case[];
  assert(cases.length > 0 && cases.every(name => CASES.includes(name)), 'Unknown probe case');
  if (!values.execute) {
    process.stdout.write(`${JSON.stringify({ cases, effects: 'Synthetic S3 objects and short-lived NO_INGRESS MicroVMs; exact cleanup' })}\n`);
    return;
  }
  for (const key of ['account', 'region', 'stack', 'image-version', 'output'] as const) {
    assert(values[key], `--${key} is required with --execute`);
  }
  const region = values.region!;
  // The production producer resolves its client region from the environment.
  process.env.AWS_REGION = region;
  process.env.AWS_DEFAULT_REGION = region;
  const aws = async <T>(args: string[]): Promise<T> => {
    const response = await command('aws', [...args, '--region', region, '--output', 'json'],
      { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(response.stdout) as T;
  };
  const cfg = { region, maxAttempts: 2 };
  const s3 = makeClient(S3Client, cfg);
  const mv = makeClient(LambdaMicrovmsClient, cfg);
  const lambda = makeClient(LambdaClient, cfg);
  const sts = makeClient(STSClient, cfg);
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  assert.equal(identity.Account, values.account, 'Wrong AWS account');
  const stack = (await aws<{
    Stacks: {
      StackId?: string; StackStatus?: string; Outputs?: { OutputKey: string; OutputValue: string }[];
    }[];
  }>(['cloudformation', 'describe-stacks', '--stack-name', values.stack!])).Stacks[0];
  assert(stack, 'Stack does not exist');
  assert(stack.StackStatus?.endsWith('_COMPLETE') && !stack.StackStatus.includes('ROLLBACK'), 'Stack is not ready');
  const outputs = Object.fromEntries((stack.Outputs ?? []).map(o => [o.OutputKey!, o.OutputValue!]));
  const resources = (await aws<{
    StackResourceSummaries: {
      ResourceType?: string; LogicalResourceId?: string; PhysicalResourceId?: string;
    }[];
  }>(['cloudformation', 'list-stack-resources', '--stack-name', values.stack!])).StackResourceSummaries;
  const fn = resources.find(r => r.ResourceType === 'AWS::Lambda::Function'
    && r.LogicalResourceId?.startsWith('TaskOrchestratorOrchestratorFn'))?.PhysicalResourceId;
  assert(fn, 'Cannot identify this stack’s coordinator');
  const env = (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn }))).Environment?.Variables ?? {};
  const bucket = env.MICROVM_PAYLOAD_BUCKET;
  const image = env.MICROVM_IMAGE_IDENTIFIER;
  const executionRole = env.MICROVM_EXECUTION_ROLE_ARN;
  const ingress = env.MICROVM_INGRESS_CONNECTOR_ARNS?.split(',') ?? [];
  const egress = env.MICROVM_EGRESS_CONNECTOR_ARNS?.split(',') ?? [];
  const logGroup = outputs.MicrovmLogGroupName;
  const foreignBucket = outputs.MicrovmArtifactBucketName;
  assert(bucket && image && executionRole && logGroup && foreignBucket && egress.length, 'Missing MicroVM settings');
  assert.equal(executionRole, outputs.MicrovmExecutionRoleArn);
  assert.equal(ingress.length, 1);
  assert(ingress[0]!.endsWith(':NO_INGRESS'), 'Probe requires deployed NO_INGRESS');
  const imageInfo = await mv.send(new GetMicrovmImageCommand({ imageIdentifier: image }));
  assert.equal(imageInfo.latestActiveImageVersion, values['image-version'], 'Unexpected active image');

  const runId = `p2-bootstrap-${randomUUID()}`;
  const directory = values.output!;
  await mkdir(directory, { recursive: false, mode: 0o700 });
  const results: Record<string, unknown>[] = [];
  const owned = new Map<string, { bucket: string; key: string }>();
  const active = new Set<string>();
  const vmIds: string[] = [];
  const taskIds: string[] = [];
  const config = { log_group_name: runId }; // valid key, deliberately incomplete configuration
  const manifestBody = JSON.stringify({ backend: 'lambda-microvm', platform_config: config, version: PAYLOAD_BOOTSTRAP.version });
  const expectedManifestKey = `${PAYLOAD_BOOTSTRAP.manifest_prefix}${createHash('sha256').update(manifestBody).digest('hex')}.json`;
  const remember = (b: string, key: string) => owned.set(`${b}/${key}`, { bucket: b, key });
  const report = async (row: Record<string, unknown>) => {
    results.push(row);
    process.stdout.write(`${JSON.stringify(row)}\n`);
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2), { mode: 0o600 });
  };
  const read = async (b: string, key: string) => {
    const response = await s3.send(new GetObjectCommand({ Bucket: b, Key: key }));
    assert(response.Body);
    return { body: await response.Body.transformToString(), etag: response.ETag, requestId: response.$metadata.requestId };
  };
  const replace = async (key: string, body: string) => {
    assert(owned.has(`${bucket}/${key}`), 'Refuse to change an unowned object');
    const current = await read(bucket, key);
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, IfMatch: current.etag }));
  };
  const stop = async (id: string) => {
    const initial = await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
    if (initial.state === 'TERMINATED') {
      active.delete(id);
      return;
    }
    if (initial.state !== 'TERMINATING') {
      await mv.send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
    }
    for (let i = 0; i < 30; i++) {
      const state = await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
      if (state.state === 'TERMINATED') {
        active.delete(id);
        return;
      }
      await delay(2_000);
    }
    throw new Error(`Termination not confirmed for ${id}`);
  };
  const awaitDiagnostic = async (id: string, started: number, expected: string, status: number) => {
    const day = new Date(started).toISOString().slice(0, 10).replaceAll('-', '/');
    const prefix = `${day}[${values['image-version']}]${id}`;
    for (let i = 0; i < 45; i++) {
      // Reuse the installed AWS CLI for logs; this live test adds no runtime SDK dependency.
      const page = await aws<{ events?: { message?: string }[] }>([
        'logs', 'filter-log-events', '--log-group-name', logGroup,
        '--log-stream-name-prefix', prefix, '--start-time', String(started),
        '--limit', '1000',
      ]);
      const messages = (page.events ?? []).map(e => e.message ?? '');
      assert(!messages.some(m => /X-Amz-(?:Signature|Credential|Security-Token)=/.test(m)), 'Bearer URL leaked to worker logs');
      assert(!messages.some(m => m.includes('hook accepted task_id=') || m.includes('installed platform_config env')),
        'Probe unexpectedly installed configuration or started a pipeline');
      if (messages.some(m => m.includes(expected))
        && messages.some(m => m.includes(`/run HTTP/1.1" ${status}`))) {
        await writeFile(join(directory, `${id}.log`), messages.map(redactPayloadUrls).join(''), { mode: 0o600 });
        return messages.filter(m => m.includes('/run hook') || m.includes('/run HTTP/1.1'))
          .map(m => redactPayloadUrls(m.trim()));
      }
      await delay(2_000);
    }
    throw new Error(`Expected worker diagnostic not observed for ${id}`);
  };

  await writeFile(join(directory, 'context.json'), JSON.stringify({
    runId,
    account: identity.Account,
    caller: identity.Arn,
    region,
    stackId: stack.StackId,
    image,
    imageVersion: values['image-version'],
    executionRole,
    ingress,
    egress,
    bucket,
    maximumDurationInSeconds: 180,
    cases,
    // Recovery coordinates contain no signed URLs. The service lifetime bounds
    // workers if this process is killed; cleanup uses only these synthetic keys.
    plannedCleanupObjects: [
      { bucket, key: expectedManifestKey },
      ...cases.flatMap(name => ['payload.json', 'launch.json'].map(filename => ({
        bucket, key: `${runId}-${name}/${filename}`,
      }))),
      ...(cases.includes('foreign-manifest') ? [{ bucket: foreignBucket, key: expectedManifestKey }] : []),
    ],
    scope: 'Production producer/S3 semantics with operator credentials; actual MicroVM consumer with unchanged worker role',
  }, null, 2), { mode: 0o600 });

  let failed = false;
  try {
    // This is the exact canonical manifest for our one-key synthetic config.
    // Record ownership before preparing, so a lost S3 reply cannot leak it.
    await assert.rejects(read(bucket, expectedManifestKey), (error: unknown) =>
      (error as { name?: string }).name === 'NoSuchKey');
    remember(bucket, expectedManifestKey);
    for (const name of cases) {
      const taskId = `${runId}-${name}`;
      taskIds.push(taskId);
      const key = `${taskId}/payload.json`;
      remember(bucket, key);
      remember(bucket, `${taskId}/launch.json`);
      const input = {
        bucket,
        taskId,
        backend: 'lambda-microvm' as const,
        payload: {
          task_id: taskId,
          description: name === 'large-payload' ? 'x'.repeat(1024 * 1024) : `Synthetic ${runId}; never start a pipeline`,
        },
        platformConfig: config,
      };
      // A unique config makes this run's shared manifest unique too. Discover
      // its exact key from the real producer, never delete a prefix/bucket.
      // Wait for BOTH writers even if one fails, before any cleanup can run.
      const prepared = await Promise.allSettled([preparePayloadReference(input), preparePayloadReference(input)]);
      const refs = prepared.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      assert.deepEqual(refs[0], refs[1], 'Competing preparations produced different capabilities');
      let reference: PayloadReference = refs[0]!;
      const manifestKey = new URL(reference.bootstrap_s3_uri).pathname.slice(1);
      assert.equal(manifestKey, expectedManifestKey, 'Producer manifest contract changed');
      assert.deepEqual(await preparePayloadReference(input), reference, 'Replay changed the saved capability');
      const original = await read(bucket, key);
      await assert.rejects(preparePayloadReference({
        ...input, payload: { ...input.payload, description: 'Conflicting synthetic instructions' },
      }), /PAYLOAD_BOOTSTRAP_CONFLICT/);
      assert.equal((await read(bucket, key)).body, original.body, 'Conflict overwrote instructions');
      // Positive control for every signed object before injecting a failure.
      const download = await fetch(reference.payload_url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      assert.equal(download.status, 200, 'Signed URL positive control failed');
      assert.equal(await download.text(), original.body);

      switch (name) {
        case 'wrong-task': {
          const doc = JSON.parse(original.body);
          doc.task_id = `${taskId}-different`;
          await replace(key, JSON.stringify(doc));
          break;
        }
        case 'wrong-config': {
          const doc = JSON.parse(original.body);
          doc.platform_config = { ...config, github_token_secret_arn: `arn:aws:secretsmanager:${region}:${identity.Account}:secret:synthetic-other-workspace` };
          await replace(key, JSON.stringify(doc));
          break;
        }
        case 'bad-json':
          await replace(key, '{ invalid synthetic JSON');
          break;
        case 'bad-signature': {
          const url = new URL(reference.payload_url);
          const signature = url.searchParams.get('X-Amz-Signature')!;
          url.searchParams.set('X-Amz-Signature', `${signature[0] === '0' ? '1' : '0'}${signature.slice(1)}`);
          reference = { ...reference, payload_url: url.toString() };
          break;
        }
        case 'wrong-path': {
          const url = new URL(reference.payload_url);
          url.pathname = url.pathname.replace(/\/payload\.json$/, '/different.json');
          reference = { ...reference, payload_url: url.toString() };
          break;
        }
        case 'bad-manifest-digest':
          // JSON meaning stays identical; the fingerprint must reject different bytes.
          await replace(manifestKey, `${manifestBody} `);
          break;
        case 'expired-url': {
          const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 1 });
          await delay(2_100);
          const expired = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
          assert.equal(expired.status, 403);
          await expired.body?.cancel();
          reference = { ...reference, payload_url: url, expires_at: Date.now() - 1 };
          break;
        }
        case 'revoked-url':
          await deletePayloadReference(bucket, taskId);
          for (const filename of ['payload.json', 'launch.json']) {
            await assert.rejects(read(bucket, `${taskId}/${filename}`), (error: unknown) =>
              (error as { name?: string }).name === 'NoSuchKey');
          }
          break;
        case 'foreign-manifest': {
          const manifest = await read(bucket, manifestKey);
          await assert.rejects(read(foreignBucket, manifestKey), (error: unknown) =>
            (error as { name?: string }).name === 'NoSuchKey');
          remember(foreignBucket, manifestKey);
          await s3.send(new PutObjectCommand({
            Bucket: foreignBucket, Key: manifestKey, Body: manifest.body, IfNoneMatch: '*',
          }));
          assert.equal((await read(foreignBucket, manifestKey)).body, manifest.body);
          reference = { ...reference, bootstrap_s3_uri: `s3://${foreignBucket}/${manifestKey}` };
          break;
        }
        case 'valid-transport':
        case 'large-payload':
          break;
      }
      const request = {
        imageIdentifier: image,
        imageVersion: values['image-version'],
        executionRoleArn: executionRole,
        ingressNetworkConnectors: ingress,
        egressNetworkConnectors: egress,
        logging: { cloudWatch: { logGroup } },
        maximumDurationInSeconds: 180,
        clientToken: randomUUID(),
        runHookPayload: JSON.stringify(reference),
      };
      assert(Buffer.byteLength(request.runHookPayload) <= 4_096, 'Reference exceeds the verified hook limit');
      const started = Date.now();
      const startedVm = await mv.send(new RunMicrovmCommand(request));
      assert(startedVm.microvmId, 'Run returned no handle; bounded service lifetime is the backstop');
      const id = startedVm.microvmId;
      active.add(id);
      vmIds.push(id);
      await report({
        case: name,
        stage: 'started',
        vmId: id,
        taskId,
        runRequestId: startedVm.$metadata.requestId,
        getObjectRequestId: original.requestId,
        signedDownloadRequestId: download.headers.get('x-amz-request-id'),
        storedPayloadBytes: Buffer.byteLength(original.body),
        hookReferenceBytes: Buffer.byteLength(request.runHookPayload),
        requestFingerprint: createHash('sha256').update(JSON.stringify(request)).digest('hex'),
      });
      try {
        const replay = await mv.send(new RunMicrovmCommand(request));
        if (replay.microvmId && replay.microvmId !== id) {
          active.add(replay.microvmId);
          vmIds.push(replay.microvmId);
        }
        assert.equal(replay.microvmId, id, 'Same token/request created another MicroVM');
        const status = ['valid-transport', 'large-payload', 'wrong-task', 'wrong-config', 'wrong-path'].includes(name) ? 400 : 500;
        const diagnostics = await awaitDiagnostic(id, started, EXPECTED[name], status);
        const observed = await mv.send(new GetMicrovmCommand({ microvmIdentifier: id }));
        assert.deepEqual(observed.ingressNetworkConnectors, ingress);
        await report({
          case: name,
          stage: 'passed',
          vmId: id,
          diagnostics,
          observedState: observed.state,
          repeatRunSameId: true,
          preparationReplayAndConflict: true,
        });
      } finally {
        await stop(id);
      }
    }
  } catch (error) {
    failed = true;
    await report({ stage: 'failed', error: safeError(error) });
  } finally {
    for (const id of [...active]) {
      try { await stop(id); } catch (error) {
        failed = true;
        await report({ stage: 'cleanup-failed', vmId: id, error: safeError(error) });
      }
    }
    // Call the real finalizer helper first (revoked-url separately asserts its
    // effect); operator cleanup removes only this probe's exact synthetic keys.
    for (const taskId of taskIds) await deletePayloadReference(bucket, taskId);
    for (const object of owned.values()) {
      await s3.send(new DeleteObjectCommand({ Bucket: object.bucket, Key: object.key }));
      await assert.rejects(read(object.bucket, object.key), (error: unknown) =>
        (error as { name?: string }).name === 'NoSuchKey');
    }
    await report({
      stage: active.size ? 'cleanup-incomplete' : 'cleanup-complete',
      vmIds,
      activeVmIds: [...active],
      deletedObjects: owned.size,
    });
  }
  if (failed) process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`${safeError(error)}\n`);
  process.exitCode = 1;
});
