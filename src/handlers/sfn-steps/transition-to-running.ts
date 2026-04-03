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

import { TaskStatus } from '../../constructs/task-status';
import { emitTaskEvent, transitionTask } from '../shared/orchestrator';
import type { BlueprintConfig } from '../shared/repo-config';
import type { TaskRecord } from '../shared/types';

interface TransitionToRunningInput {
  readonly task: TaskRecord;
  readonly blueprintConfig: BlueprintConfig;
  readonly payload: Record<string, unknown>;
}

interface ContainerEnvVars {
  readonly REPO_URL: string;
  readonly TASK_DESCRIPTION: string;
  readonly ISSUE_NUMBER: string;
  readonly MAX_TURNS: string;
  readonly MAX_BUDGET_USD: string;
  readonly ANTHROPIC_MODEL: string;
  readonly TASK_ID: string;
  readonly SYSTEM_PROMPT_OVERRIDES: string;
}

interface TransitionToRunningOutput {
  readonly task: TaskRecord;
  readonly payload: Record<string, unknown>;
  readonly containerEnv: ContainerEnvVars;
}

export async function handler(event: TransitionToRunningInput): Promise<TransitionToRunningOutput> {
  const startedAt = new Date().toISOString();

  await transitionTask(event.task.task_id, TaskStatus.HYDRATING, TaskStatus.RUNNING, {
    started_at: startedAt,
  });
  await emitTaskEvent(event.task.task_id, 'task_running', { started_at: startedAt });

  const payload = event.payload;
  const containerEnv: ContainerEnvVars = {
    REPO_URL: String(payload.repo_url ?? ''),
    TASK_DESCRIPTION: String(payload.prompt ?? ''),
    ISSUE_NUMBER: String(payload.issue_number ?? ''),
    MAX_TURNS: String(payload.max_turns ?? '100'),
    MAX_BUDGET_USD: String(payload.max_budget_usd ?? '0'),
    ANTHROPIC_MODEL: String(payload.model_id ?? ''),
    TASK_ID: String(event.task.task_id ?? ''),
    SYSTEM_PROMPT_OVERRIDES: String(payload.system_prompt_overrides ?? ''),
  };

  // Strip large fields from state to avoid hitting the 256 KB Step Functions state limit
  const { hydrated_context: _, ...minimalPayload } = event.payload;

  return { task: event.task, payload: minimalPayload, containerEnv };
}
