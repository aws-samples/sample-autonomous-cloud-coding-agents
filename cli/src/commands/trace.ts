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

import { createWriteStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { ApiError, CliError } from '../errors';

const TRACE_DOWNLOAD_TIMEOUT_MS = 120_000;

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function isZlibError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === 'string' && e.code.startsWith('Z_')) return true;
  if (typeof e.message === 'string' &&
      /zlib|gzip|incorrect header check|invalid stored block/i.test(e.message)) {
    return true;
  }
  return false;
}

/**
 * ``bgagent trace download <task-id>`` — fetch the ``--trace``
 * trajectory dump for a task (design §10.1).
 *
 * Output contract:
 *   * Default (stdout):       gunzipped JSONL (pipe-friendly for ``jq -s .``)
 *   * ``-o <file>`` (file):   raw gzipped bytes (preserves the artifact as-is)
 */
export function makeTraceCommand(): Command {
  const trace = new Command('trace').description('--trace artifact commands (design §10.1)');

  trace
    .command('download')
    .description('Download the --trace trajectory dump for a task')
    .argument('<task-id>', 'Task ID')
    .option(
      '-o, --output <file>',
      'Write raw gzipped bytes to <file> instead of gunzipped to stdout. Use --force to overwrite an existing file.',
    )
    .option('-f, --force', 'Overwrite the output file if it already exists')
    .action(async (taskId: string, opts: { output?: string; force?: boolean }) => {
      if (opts.output && !opts.force && existsSync(opts.output)) {
        throw new CliError(
          `Refusing to overwrite existing file ${opts.output}. Pass --force to overwrite.`,
        );
      }

      const client = new ApiClient();

      let urlInfo;
      try {
        urlInfo = await client.getTraceUrl(taskId);
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404 && err.errorCode === 'TRACE_NOT_AVAILABLE') {
          throw new CliError(
            `No trace artifact for task ${taskId}. Either the task did not run with --trace or the upload has not completed. Re-submit with 'bgagent submit --trace ...' to capture a new trace.`,
          );
        }
        throw err;
      }

      const ac = new AbortController();
      const timer = setTimeout(
        () => ac.abort(new Error('Trace download timed out after 2 minutes')),
        TRACE_DOWNLOAD_TIMEOUT_MS,
      );
      const onSigint = (): void => ac.abort(new Error('Cancelled by user'));
      process.on('SIGINT', onSigint);

      try {
        let s3Response: Response;
        try {
          s3Response = await fetch(urlInfo.url, { signal: ac.signal });
        } catch (err) {
          if (isAbortError(err)) {
            const reason = ac.signal.reason;
            const reasonMsg = reason instanceof Error ? reason.message : String(reason ?? 'aborted');
            throw new CliError(`Trace download aborted: ${reasonMsg}`);
          }
          throw err;
        }

        if (!s3Response.ok) {
          throw new CliError(
            `S3 download failed: HTTP ${s3Response.status} ${s3Response.statusText}. ` +
              'The presigned URL may have expired (15-minute TTL). Try \'bgagent trace download\' again.',
          );
        }
        if (!s3Response.body) {
          throw new CliError('S3 response had no body.');
        }

        const nodeReadable = Readable.fromWeb(s3Response.body as unknown as WebReadableStream);

        if (opts.output) {
          await pipeline(nodeReadable, createWriteStream(opts.output));
          console.error(`Wrote ${opts.output}`);
          return;
        }

        try {
          await pipeline(nodeReadable, createGunzip(), process.stdout);
        } catch (err) {
          if (isZlibError(err)) {
            throw new CliError(
              `Trace artifact is corrupt or not gzipped (${(err as Error).message}). ` +
                `Re-download with 'bgagent trace download ${taskId}' or inspect the raw bytes with '-o <file>'.`,
            );
          }
          throw err;
        }
      } finally {
        clearTimeout(timer);
        process.off('SIGINT', onSigint);
      }
    });

  return trace;
}
