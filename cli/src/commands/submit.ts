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

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import { ApiClient } from '../api-client';
import { CliError } from '../errors';
import { formatJson, formatTaskDetail } from '../format';
import {
  APPROVAL_TIMEOUT_S_MAX,
  APPROVAL_TIMEOUT_S_MIN,
  ApprovalScope,
  Attachment,
  AttachmentType,
  AttachmentUploadInstruction,
  CreateTaskRequest,
  INITIAL_APPROVALS_MAX_ENTRIES,
  INITIAL_APPROVALS_MAX_ENTRY_LENGTH,
} from '../types';
import { exitCodeForStatus, waitForTask } from '../wait';

/** Scope prefixes the server accepts (see ``parseApprovalScope`` on the
 *  CDK side). Special short forms without ``:`` are also valid. */
const SCOPE_PREFIXES = [
  'tool_type:',
  'tool_group:',
  'bash_pattern:',
  'write_path:',
  'rule:',
] as const;
const SCOPE_SHORT_FORMS = new Set([
  'this_call',
  'tool_type_session',
  'tool_group_session',
  'all_session',
]);

function collect<T>(value: T, previous: readonly T[]): readonly T[] {
  return [...previous, value];
}

export function makeSubmitCommand(): Command {
  return new Command('submit')
    .description('Submit a new task')
    .requiredOption('--repo <owner/repo>', 'GitHub repository (owner/repo)')
    .option('--issue <number>', 'GitHub issue number', parseInt)
    .option('--task <description>', 'Task description')
    .option('--max-turns <number>', 'Maximum agent turns (1-500)', parseInt)
    .option('--max-budget <dollars>', 'Maximum budget in USD (0.01-100)', parseFloat)
    .option('--pr <number>', 'PR number to iterate on (sets task_type to pr_iteration)', parseInt)
    .option('--review-pr <number>', 'PR number to review (sets task_type to pr_review)', parseInt)
    .option('--idempotency-key <key>', 'Idempotency key for deduplication')
    .option('--trace', 'Capture 4 KB debug previews (design §10.1). Opt-in per task; not routine observability.')
    .option(
      '--attachment <path-or-url>',
      'Attach a local file or URL (repeatable). Local files ≤ 500 KB are sent inline; URLs are fetched by the agent.',
      collect<string>,
      [] as readonly string[],
    )
    .option(
      '--approval-timeout <seconds>',
      `Cedar HITL per-task default approval timeout (${APPROVAL_TIMEOUT_S_MIN}-${APPROVAL_TIMEOUT_S_MAX}s). `
        + 'Overrides the platform default of 300s. Per-rule @approval_timeout_s still min-wins at gate-firing.',
      parseInt,
    )
    .option(
      '--pre-approve <scope>',
      'Cedar HITL pre-approval scope to seed at task start (repeatable). '
        + 'Valid forms: this_call, tool_type_session, tool_group_session, all_session, '
        + 'tool_type:<name>, tool_group:<name>, bash_pattern:<glob>, write_path:<glob>, rule:<id>.',
      collect<string>,
      [] as readonly string[],
    )
    .option('--wait', 'Wait for task to complete')
    .option('--output <format>', 'Output format (text or json)', 'text')
    .action(async (opts) => {
      if (opts.pr !== undefined && isNaN(opts.pr)) {
        throw new CliError('--pr must be a valid number.');
      }
      if (opts.reviewPr !== undefined && isNaN(opts.reviewPr)) {
        throw new CliError('--review-pr must be a valid number.');
      }
      if (opts.pr !== undefined && opts.reviewPr !== undefined) {
        throw new CliError('--pr and --review-pr cannot be used together.');
      }
      if (opts.pr === undefined && opts.reviewPr === undefined && opts.issue === undefined && !opts.task) {
        throw new CliError('At least one of --issue, --task, --pr, or --review-pr is required.');
      }
      if (opts.issue !== undefined && isNaN(opts.issue)) {
        throw new CliError('--issue must be a valid number.');
      }
      if (opts.maxTurns !== undefined) {
        if (isNaN(opts.maxTurns) || !Number.isInteger(opts.maxTurns) || opts.maxTurns < 1 || opts.maxTurns > 500) {
          throw new CliError('--max-turns must be an integer between 1 and 500.');
        }
      }
      if (opts.maxBudget !== undefined) {
        if (isNaN(opts.maxBudget) || opts.maxBudget < 0.01 || opts.maxBudget > 100) {
          throw new CliError('--max-budget must be a number between 0.01 and 100.');
        }
      }
      if (opts.approvalTimeout !== undefined) {
        if (
          isNaN(opts.approvalTimeout)
          || !Number.isInteger(opts.approvalTimeout)
          || opts.approvalTimeout < APPROVAL_TIMEOUT_S_MIN
          || opts.approvalTimeout > APPROVAL_TIMEOUT_S_MAX
        ) {
          throw new CliError(
            `--approval-timeout must be an integer between ${APPROVAL_TIMEOUT_S_MIN} `
              + `and ${APPROVAL_TIMEOUT_S_MAX} seconds.`,
          );
        }
      }
      const preApproveRaw = (opts.preApprove ?? []) as readonly string[];
      let initialApprovals: readonly ApprovalScope[] | undefined;
      if (preApproveRaw.length > 0) {
        if (preApproveRaw.length > INITIAL_APPROVALS_MAX_ENTRIES) {
          throw new CliError(
            `--pre-approve exceeds ${INITIAL_APPROVALS_MAX_ENTRIES} entries.`,
          );
        }
        for (const scope of preApproveRaw) {
          if (scope.length > INITIAL_APPROVALS_MAX_ENTRY_LENGTH) {
            throw new CliError(
              `--pre-approve "${scope}" exceeds ${INITIAL_APPROVALS_MAX_ENTRY_LENGTH} characters.`,
            );
          }
          if (
            !SCOPE_SHORT_FORMS.has(scope)
            && !SCOPE_PREFIXES.some((p) => scope.startsWith(p) && scope.length > p.length)
          ) {
            throw new CliError(
              `--pre-approve "${scope}" has an invalid scope. Use one of: `
                + 'this_call, tool_type_session, tool_group_session, all_session, '
                + 'or a prefix: tool_type:, tool_group:, bash_pattern:, write_path:, rule:.',
            );
          }
        }
        initialApprovals = preApproveRaw as readonly ApprovalScope[];
      }

      // Resolve --attachment arguments into API attachment objects
      const attachmentArgs = (opts.attachment ?? []) as readonly string[];
      const attachments: Attachment[] = [];
      if (attachmentArgs.length > 0) {
        if (attachmentArgs.length > 10) {
          throw new CliError('Maximum 10 attachments per task.');
        }
        for (const arg of attachmentArgs) {
          attachments.push(resolveAttachmentArg(arg));
        }
      }

      const client = new ApiClient();
      const body: CreateTaskRequest = {
        repo: opts.repo,
        ...(opts.issue !== undefined && { issue_number: opts.issue }),
        ...(opts.task && { task_description: opts.task }),
        ...(opts.maxTurns !== undefined && { max_turns: opts.maxTurns }),
        ...(opts.maxBudget !== undefined && { max_budget_usd: opts.maxBudget }),
        // Note: --pr and --review-pr are mutually exclusive (validated above).
        ...(opts.pr !== undefined && { task_type: 'pr_iteration' as const, pr_number: opts.pr }),
        ...(opts.reviewPr !== undefined && { task_type: 'pr_review' as const, pr_number: opts.reviewPr }),
        ...(opts.trace && { trace: true }),
        ...(opts.approvalTimeout !== undefined && { approval_timeout_s: opts.approvalTimeout }),
        ...(initialApprovals !== undefined && { initial_approvals: initialApprovals }),
        ...(attachments.length > 0 && { attachments }),
      };

      const createResponse = await client.createTask(body, opts.idempotencyKey);

      // If presigned uploads are needed, upload files and confirm
      let task = createResponse;
      if (createResponse.upload_instructions && createResponse.upload_instructions.length > 0) {
        process.stderr.write(`Uploading ${createResponse.upload_instructions.length} attachment(s)...\n`);
        for (const instruction of createResponse.upload_instructions) {
          const localAtt = attachments.find(a => a.filename === instruction.filename);
          if (!localAtt || !localAtt.filename) {
            throw new CliError(`No local file found for upload instruction: ${instruction.filename}`);
          }
          const filePath = attachmentArgs.find(arg =>
            !arg.startsWith('http') && path.basename(path.resolve(arg)) === instruction.filename,
          );
          if (!filePath) {
            throw new CliError(`Cannot locate local file for presigned upload: ${instruction.filename}`);
          }
          await uploadViaPresignedPost(path.resolve(filePath), instruction);
          process.stderr.write(`  Uploaded: ${instruction.filename}\n`);
        }

        // Confirm uploads to trigger screening and transition to SUBMITTED
        process.stderr.write('Confirming uploads...\n');
        task = await client.confirmUploads(createResponse.task_id);
      }

      if (opts.wait) {
        process.stderr.write('\n');
        const finalTask = await waitForTask(client, task.task_id);
        process.stderr.write('\n');
        console.log(opts.output === 'json' ? formatJson(finalTask) : formatTaskDetail(finalTask));
        process.exitCode = exitCodeForStatus(finalTask.status);
      } else {
        console.log(opts.output === 'json' ? formatJson(task) : formatTaskDetail(task));
      }
    });
}

// ---------------------------------------------------------------------------
// Attachment resolution helpers
// ---------------------------------------------------------------------------

const MAX_INLINE_SIZE_BYTES = 500 * 1024; // 500 KB

/** MIME type lookup by file extension. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.log': 'text/x-log',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Resolve a CLI --attachment argument to an Attachment object.
 * Handles URLs (https://...) and local file paths.
 */
function resolveAttachmentArg(arg: string): Attachment {
  // URL detection: starts with https://
  // Omit content_type for URLs — the server-side resolver determines the
  // actual content type from the HTTP response's Content-Type header.
  if (arg.startsWith('https://')) {
    return { type: 'url', url: arg };
  }

  if (arg.startsWith('http://')) {
    throw new CliError(`URL attachments must use HTTPS: ${arg}`);
  }

  // Local file
  const resolvedPath = path.resolve(arg);
  if (!fs.existsSync(resolvedPath)) {
    throw new CliError(`Attachment file not found: ${arg}`);
  }

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new CliError(`Attachment path is not a file: ${arg}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const contentType = MIME_BY_EXT[ext];
  if (!contentType) {
    throw new CliError(
      `Unsupported file type '${ext}' for attachment: ${arg}. ` +
      `Supported: ${Object.keys(MIME_BY_EXT).join(', ')}`,
    );
  }

  const type: AttachmentType = IMAGE_MIMES.has(contentType) ? 'image' : 'file';

  if (stat.size > MAX_INLINE_SIZE_BYTES) {
    // Large file: use presigned upload path (metadata only, no data)
    return {
      type,
      content_type: contentType,
      filename: path.basename(resolvedPath),
      expected_size_bytes: stat.size,
    };
  }

  const data = fs.readFileSync(resolvedPath);

  return {
    type,
    content_type: contentType,
    filename: path.basename(resolvedPath),
    data: data.toString('base64'),
  };
}

// ---------------------------------------------------------------------------
// Presigned POST upload helper
// ---------------------------------------------------------------------------

/**
 * Upload a local file to S3 via a presigned POST (multipart/form-data).
 * Policy fields from the API must precede the file; use FormData so Node sets
 * the boundary and Content-Length correctly for multi-megabyte payloads.
 */
/** Upload timeout: 2 minutes for large files. */
const UPLOAD_TIMEOUT_MS = 120_000;

async function uploadViaPresignedPost(
  filePath: string,
  instruction: AttachmentUploadInstruction,
): Promise<void> {
  const fileData = fs.readFileSync(filePath);

  const form = new FormData();
  for (const [key, value] of Object.entries(instruction.upload_fields)) {
    form.append(key, value);
  }
  // File must be last. S3 POST Object uses Content-Type from the policy field,
  // not the multipart part — do not set a part Content-Type (breaks some clients).
  form.append('file', new Blob([fileData]), path.basename(filePath));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(instruction.upload_url, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new CliError(
        `Upload timed out for ${instruction.filename} after ${UPLOAD_TIMEOUT_MS / 1000}s. ` +
        'Check your network connection and try again.',
      );
    }
    throw new CliError(
      `Upload failed for ${instruction.filename}: ${err.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  // S3 POST Object returns 204 on success. Some error conditions return 200
  // with an XML error body (e.g., KMS failures). Check for XML error pattern.
  const text = await res.text().catch(() => '');
  if (!res.ok || (res.status === 200 && text.includes('<Error>'))) {
    throw new CliError(
      `Presigned upload failed for ${instruction.filename}: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
    );
  }
}
