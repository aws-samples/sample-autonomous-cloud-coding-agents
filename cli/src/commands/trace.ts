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

import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { createGunzip } from 'node:zlib';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { ApiError, CliError } from '../errors';

/**
 * ``bgagent trace download <task-id>`` — fetch the ``--trace``
 * trajectory dump for a task (design §10.1).
 *
 * Output contract:
 *   * Default (stdout):       gunzipped JSONL (pipe-friendly for ``jq -s .``)
 *   * ``-o <file>`` (file):   raw gzipped bytes (preserves the artifact as-is)
 *
 * The server returns a 15-minute presigned URL; we stream from S3
 * directly so multi-MB artifacts don't buffer in CLI memory.
 */
export function makeTraceCommand(): Command {
  const trace = new Command('trace').description('--trace artifact commands (design §10.1)');

  trace
    .command('download')
    .description('Download the --trace trajectory dump for a task')
    .argument('<task-id>', 'Task ID')
    .option('-o, --output <file>', 'Write raw gzipped bytes to <file> instead of gunzipped to stdout')
    .action(async (taskId: string, opts: { output?: string }) => {
      const client = new ApiClient();

      let urlInfo;
      try {
        urlInfo = await client.getTraceUrl(taskId);
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 404 && err.errorCode === 'TRACE_NOT_AVAILABLE') {
          // Friendlier message than the raw API body — users typically
          // don't know which of "did not run with --trace" vs. "not yet
          // uploaded" applies, and both have the same remedy.
          throw new CliError(
            `No trace artifact for task ${taskId}. Either the task did not run with --trace or the upload has not completed. Re-submit with 'bgagent submit --trace ...' to capture a new trace.`,
          );
        }
        throw err;
      }

      const s3Response = await fetch(urlInfo.url);
      if (!s3Response.ok) {
        throw new CliError(
          `S3 download failed: HTTP ${s3Response.status} ${s3Response.statusText}. ` +
            `The presigned URL may have expired (15-minute TTL). Try 'bgagent trace download' again.`,
        );
      }
      if (!s3Response.body) {
        throw new CliError('S3 response had no body.');
      }

      // ``ReadableStream`` from fetch -> Node Readable -> consumer.
      // ``fromWeb`` typing in Node's types expects a WHATWG stream; the
      // fetch response body matches.
      const nodeReadable = Readable.fromWeb(s3Response.body as unknown as WebReadableStream);

      if (opts.output) {
        // -o <file>: write raw gzipped bytes as-is. Preserves the
        // artifact for archival / re-inspection with standard tools
        // (``zcat file | jq -s .``).
        await pipeline(nodeReadable, createWriteStream(opts.output));
        // Status line on stderr so it does not pollute stdout (which
        // users may be piping through other tools).
        console.error(`Wrote ${opts.output}`);
        return;
      }

      // Default: gunzip to stdout so the pipe contract is ``jq -s .``-
      // friendly. stdout is a TTY or a pipe; either way the consumer
      // wants plain JSONL.
      await pipeline(nodeReadable, createGunzip(), process.stdout);
    });

  return trace;
}
