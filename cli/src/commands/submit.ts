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
import { ApiError, CliError } from '../errors';
import { formatJson, formatTaskDetail } from '../format';
import { abortableSleep, isTransientError } from '../retry';
import {
  APPROVAL_TIMEOUT_S_MAX,
  APPROVAL_TIMEOUT_S_MIN,
  ApprovalScope,
  Attachment,
  AttachmentType,
  AttachmentUploadInstruction,
  CreateTaskRequest,
  CreateTaskResponse,
  DEFAULT_CODING_WORKFLOW_ID,
  INITIAL_APPROVALS_MAX_ENTRIES,
  INITIAL_APPROVALS_MAX_ENTRY_LENGTH,
  MAX_BUDGET_USD_MAX,
  MAX_BUDGET_USD_MIN,
  MICROVM_SLEEP_AFTER_S_DEFAULT,
  MICROVM_SLEEP_AFTER_S_MAX,
  MICROVM_SLEEP_AFTER_S_MIN,
  TaskDetail,
  TERMINAL_STATUSES,
} from '../types';
import { exitCodeForStatus, waitForTask } from '../wait';

const SCOPE_PREFIXES = [
  'tool_type:',
  'tool_group:',
  'bash_pattern:',
  'write_path:',
  'rule:',
] as const;

function collect<T>(value: T, previous: readonly T[]): readonly T[] {
  return [...previous, value];
}

export function makeSubmitCommand(): Command {
  return new Command('submit')
    .description('Submit a new task')
    .option('--repo <owner/repo>', 'GitHub repository (owner/repo). Required unless --workflow selects a repo-less workflow (e.g. knowledge/web-research-v1).')
    .option('--issue <number>', 'GitHub issue number', parseInt)
    .option('--task <description>', 'Task description')
    .option('--max-turns <number>', 'Maximum agent turns (1-500)', parseInt)
    .option('--max-budget <dollars>', 'Maximum budget in USD (0.01-100)', parseFloat)
    .option('--pr <number>', 'PR number to iterate on (selects the coding/pr-iteration-v1 workflow)', parseInt)
    .option('--review-pr <number>', 'PR number to review (selects the coding/pr-review-v1 workflow)', parseInt)
    .option(
      '--workflow <id>',
      'Workflow to run, as <id>[@<constraint>] (e.g. coding/new-task-v1). '
        + 'Overrides the workflow implied by --pr/--review-pr; without any of the three, coding/new-task-v1 is sent.',
    )
    .option('--idempotency-key <key>', 'Idempotency key for deduplication')
    .option('--trace', 'Capture 4 KB debug previews (design §10.1). Opt-in per task; not routine observability.')
    .option(
      '--attachment <path-or-url>',
      'Attach a local file or URL (repeatable). Local files ≤ 500 KB are sent inline, up to 3 MB in total; URLs are fetched by the platform before the agent starts.',
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
      '--microvm-sleep-after <seconds|off>',
      `Sleep while waiting for approval after this many seconds (default ${MICROVM_SLEEP_AFTER_S_DEFAULT}; `
        + 'off keeps the worker awake). MicroVM only; requires platform sleep support and does not extend approval deadlines.',
    )
    .option(
      '--pre-approve <scope>',
      'Cedar HITL pre-approval scope to seed at task start (repeatable). '
        + 'Valid forms: all_session, '
        + 'tool_type:<name>, tool_group:<name>, bash_pattern:<glob>, write_path:<glob>, rule:<id>.',
      collect<string>,
      [] as readonly string[],
    )
    .option('--wait', 'Wait for task to complete')
    .option('--output <format>', 'Output format (text or json)', 'text')
    // eslint-disable-next-line complexity -- predates the ceiling (68, down from 70 when it landed); must not grow
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
      if (!opts.repo && !opts.workflow) {
        throw new CliError('--repo is required (omit it only with --workflow for a repo-less workflow).');
      }
      if (!opts.repo && (opts.pr !== undefined || opts.reviewPr !== undefined)) {
        throw new CliError('--repo is required with --pr/--review-pr (PR workflows operate on a repo).');
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
        if (isNaN(opts.maxBudget) || opts.maxBudget < MAX_BUDGET_USD_MIN || opts.maxBudget > MAX_BUDGET_USD_MAX) {
          throw new CliError(`--max-budget must be a number between ${MAX_BUDGET_USD_MIN} and ${MAX_BUDGET_USD_MAX}.`);
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
      const microvmSleepAfter = microvmSleepAfterField(opts.microvmSleepAfter as string | undefined);
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
            scope !== 'all_session'
            && !SCOPE_PREFIXES.some((p) => scope.startsWith(p) && scope.length > p.length)
          ) {
            throw new CliError(
              `--pre-approve "${scope}" has an invalid scope. Use all_session `
                + 'or a prefix: tool_type:, tool_group:, bash_pattern:, write_path:, rule:.',
            );
          }
        }
        initialApprovals = preApproveRaw as readonly ApprovalScope[];
      }

      const attachmentArgs = (opts.attachment ?? []) as readonly string[];
      const attachments: Attachment[] = [];
      if (attachmentArgs.length > 0) {
        if (attachmentArgs.length > 10) {
          throw new CliError('Maximum 10 attachments per task.');
        }
        let inlineBytes = 0;
        for (const arg of attachmentArgs) {
          const attachment = resolveAttachmentArg(arg, inlineBytes);
          inlineBytes += Buffer.byteLength(attachment.data ?? '', 'base64');
          attachments.push(attachment);
        }
      }

      let workflowRef: string | undefined = opts.workflow;
      if (workflowRef === undefined && opts.pr !== undefined) {
        workflowRef = 'coding/pr-iteration-v1';
      } else if (workflowRef === undefined && opts.reviewPr !== undefined) {
        workflowRef = 'coding/pr-review-v1';
      } else if (workflowRef === undefined && opts.repo) {
        workflowRef = DEFAULT_CODING_WORKFLOW_ID;
      }
      const prNumber = opts.pr ?? opts.reviewPr;

      const client = new ApiClient();
      const body: CreateTaskRequest = {
        ...(opts.repo && { repo: opts.repo }),
        ...(opts.issue !== undefined && { issue_number: opts.issue }),
        ...(opts.task && { task_description: opts.task }),
        ...(opts.maxTurns !== undefined && { max_turns: opts.maxTurns }),
        ...(opts.maxBudget !== undefined && { max_budget_usd: opts.maxBudget }),
        ...(workflowRef !== undefined && { workflow_ref: workflowRef }),
        ...(prNumber !== undefined && { pr_number: prNumber }),
        ...(opts.trace && { trace: true }),
        ...(opts.approvalTimeout !== undefined && { approval_timeout_s: opts.approvalTimeout }),
        ...microvmSleepAfter,
        ...(initialApprovals !== undefined && { initial_approvals: initialApprovals }),
        ...(attachments.length > 0 && { attachments }),
      };

      const createResponse = await client.createTask(body, opts.idempotencyKey);

      let task = createResponse;
      if (createResponse.upload_instructions && createResponse.upload_instructions.length > 0) {
        process.stderr.write(`Uploading ${createResponse.upload_instructions.length} attachment(s)...\n`);
        const toUpload = attachmentArgs.filter((_, i) => attachments[i].expected_size_bytes !== undefined);
        for (const instruction of createResponse.upload_instructions) {
          await uploadViaPresignedPost(fileToUpload(instruction, createResponse, toUpload), instruction);
          process.stderr.write(`  Uploaded: ${instruction.filename}\n`);
        }

        process.stderr.write('Confirming uploads...\n');
        task = await confirmUploadsWithRetry(client, createResponse.task_id);
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

function microvmSleepAfterField(raw: string | undefined): { microvm_sleep_after_s?: number } {
  if (raw === undefined) return {};
  const seconds = raw === 'off' ? 0 : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < MICROVM_SLEEP_AFTER_S_MIN || seconds > MICROVM_SLEEP_AFTER_S_MAX) {
    throw new CliError('--microvm-sleep-after must be off or an integer between '
      + `${MICROVM_SLEEP_AFTER_S_MIN} and ${MICROVM_SLEEP_AFTER_S_MAX} seconds.`);
  }
  return { microvm_sleep_after_s: seconds };
}

function safeResolvePath(userPath: string): string {
  // nosemgrep: path-join-resolve-traversal -- this IS the path-traversal guard
  const resolved = path.resolve(userPath);
  const cwd = process.cwd();
  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
    throw new CliError(
      `Attachment path must be within the working directory: ${userPath}`,
    );
  }
  return resolved;
}

function fileToUpload(
  instruction: AttachmentUploadInstruction,
  task: CreateTaskResponse,
  declared: readonly string[],
): string {
  const files = declared.filter(file => path.basename(safeResolvePath(file)) === instruction.filename);
  const uploads = (task.attachments ?? []).filter(a => a.filename === instruction.filename).slice(-files.length);
  const file = files[uploads.findIndex(a => a.attachment_id === instruction.attachment_id)];
  if (file === undefined) {
    throw new CliError(`No local file found for upload instruction: ${instruction.filename}`);
  }
  return safeResolvePath(file);
}

const MAX_INLINE_SIZE_BYTES = 500 * 1024;

const MAX_TOTAL_INLINE_SIZE_MB = 3;
const MAX_TOTAL_INLINE_SIZE_BYTES = MAX_TOTAL_INLINE_SIZE_MB * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.txt': 'text/plain',
  '.log': 'text/x-log',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
};

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);

function resolveAttachmentArg(arg: string, inlineBytes: number): Attachment {
  if (arg.startsWith('https://')) {
    return { type: 'url', url: arg };
  }

  if (arg.startsWith('http://')) {
    throw new CliError(`URL attachments must use HTTPS: ${arg}`);
  }

  const resolvedPath = safeResolvePath(arg);
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

  if (stat.size > MAX_INLINE_SIZE_BYTES || inlineBytes + stat.size > MAX_TOTAL_INLINE_SIZE_BYTES) {
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
  // S3 POST Object ignores every form field after the file.
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
  } catch (err) {
    const { name, message } = err as { name?: string; message?: string };
    if (name === 'AbortError') {
      throw new CliError(
        `Upload timed out for ${instruction.filename} after ${UPLOAD_TIMEOUT_MS / 1000}s. ` +
        'Check your network connection and try again.',
      );
    }
    throw new CliError(
      `Upload failed for ${instruction.filename}: ${message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  const text = await res.text().catch(() => '');
  if (!res.ok || (res.status === 200 && text.includes('<Error>'))) {
    throw new CliError(
      `Presigned upload failed for ${instruction.filename}: HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`,
    );
  }
}

const CONFIRM_MAX_ATTEMPTS = 3;

const CONFIRM_POLL_INTERVAL_MS = 5_000;

const CONFIRM_MAX_POLLS = 33;

async function confirmUploadsWithRetry(client: ApiClient, taskId: string): Promise<TaskDetail> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.confirmUploads(taskId);
    } catch (err) {
      // API Gateway ends a request after 29 s; the confirmation behind it runs on.
      const gatewayTimeout = err instanceof ApiError && err.statusCode === 504;
      if (!gatewayTimeout || attempt === CONFIRM_MAX_ATTEMPTS) throw err;
      process.stderr.write(`  Screening of task ${taskId} is still running; waiting for it to finish...\n`);
      for (let poll = 0; poll < CONFIRM_MAX_POLLS; poll++) {
        await abortableSleep(CONFIRM_POLL_INTERVAL_MS);
        let task: TaskDetail;
        try {
          task = await client.getTask(taskId);
        } catch (readErr) {
          if (!isTransientError(readErr)) throw readErr;
          continue;
        }
        if (task.status === 'PENDING_UPLOADS') continue;
        if (task.status === 'COMPLETED' || !TERMINAL_STATUSES.includes(task.status)) return task;
        throw new CliError(`Task ${taskId} is ${task.status}${task.error_message ? `: ${task.error_message}` : '.'}`);
      }
    }
  }
}
