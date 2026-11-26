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

import type { TaskStatusType } from '../../constructs/task-status';
import { classifyError, classifyMicrovmTerminalFailure, retryGuidance } from './error-classifier';

const EXCERPT_MAX = 200;

export interface FailureReplyInput {
  readonly status: TaskStatusType | string;
  readonly buildPassed?: boolean | null;
  readonly errorMessage?: string | null;
  readonly taskId: string;
}

const BUILD_GATE_FAILED_RE = /agent_status=['"]?(success|end_turn)['"]?.*build_ok\s*=\s*(False|timeout)/i;

const BUILD_GATE_TIMEOUT_RE = /agent_status=['"]?(success|end_turn)['"]?.*build_ok\s*=\s*timeout/i;

function isBuildFailure(input: Pick<FailureReplyInput, 'buildPassed' | 'errorMessage'>): boolean {
  if (classifyMicrovmTerminalFailure(input.errorMessage)) return false;
  if (input.errorMessage && BUILD_GATE_FAILED_RE.test(input.errorMessage)) {
    return true;
  }
  return input.buildPassed === false && !input.errorMessage;
}

function isBuildTimeout(input: Pick<FailureReplyInput, 'errorMessage'>): boolean {
  if (classifyMicrovmTerminalFailure(input.errorMessage)) return false;
  return !!input.errorMessage && BUILD_GATE_TIMEOUT_RE.test(input.errorMessage);
}

function excerpt(raw: string): string {
  const oneLine = raw.replace(/^MICROVM_(?:RUN_HOOK_REJECTED|SUBSTRATE_TERMINATED): /, '')
    .replace(/\s*\[auto-retried\]\s*/gi, ' ').replace(/\s+/g, ' ').trim();
  return oneLine.length > EXCERPT_MAX ? `${oneLine.slice(0, EXCERPT_MAX)}…` : oneLine;
}

/**
 * Render the ❌ failure reply body. Best-effort, never throws.
 */
export function renderFailureReply(input: FailureReplyInput): string {
  if (isBuildTimeout(input)) {
    return (
      '❌ I made the change, but the build/tests didn\'t finish in time (timed '
      + `out) — see the build log in CloudWatch for task \`${input.taskId}\`. `
      + "Reply with guidance and I'll try again."
    );
  }
  if (isBuildFailure(input)) {
    return (
      "❌ I made the change, but the build/tests didn't pass — see the build "
      + `log in CloudWatch for task \`${input.taskId}\`. Reply with guidance `
      + "and I'll try again."
    );
  }

  const classification = classifyError(input.errorMessage);
  const title = classification?.title ?? "the task didn't complete";
  const detail = input.errorMessage ? ` ${excerpt(input.errorMessage)}` : '';
  const autoRetried = wasAutoRetried(input.errorMessage);
  const nextStep = classification
    ? retryGuidance(classification, autoRetried)
    : 'Reply here with any extra guidance and I\'ll try again.';
  return (
    `❌ ${title} —${detail} see CloudWatch for task \`${input.taskId}\`. `
    + nextStep
  );
}

function wasAutoRetried(errorMessage?: string | null): boolean {
  if (classifyMicrovmTerminalFailure(errorMessage)) return false;
  return !!errorMessage && /\[auto-retried\]/i.test(errorMessage);
}

/**
 * Compose the SHORT one-line failure reason shown as a sub-line under a ❌ row
 * on the parent epic panel: classified reason + task id only, never the raw
 * (untrusted) build output. Returns null when there's no task id to point at.
 * ``isIntegration`` tailors the build-failure wording to name the merge.
 */
export function renderPanelFailureReason(input: {
  readonly buildPassed?: boolean | null;
  readonly errorMessage?: string | null;
  readonly taskId?: string;
  readonly isIntegration?: boolean;
}): string | null {
  if (!input.taskId) return null;
  if (isBuildTimeout(input)) {
    const what = input.isIntegration
      ? 'Combined build timed out after merging the sub-issue branches'
      : 'Build/tests timed out';
    return `${what} — see the build log in CloudWatch for task \`${input.taskId}\`.`;
  }
  if (isBuildFailure(input)) {
    const what = input.isIntegration
      ? 'Combined build failed after merging the sub-issue branches'
      : 'Build/tests failed';
    return `${what} — see the build log in CloudWatch for task \`${input.taskId}\`.`;
  }
  const classification = classifyError(input.errorMessage);
  const title = classification?.title ?? "the task didn't complete";
  const nextStep = classification
    ? ` ${retryGuidance(classification, wasAutoRetried(input.errorMessage))}`
    : '';
  return `${title} — see CloudWatch for task \`${input.taskId}\`.${nextStep}`;
}
