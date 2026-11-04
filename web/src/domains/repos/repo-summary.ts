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

import type { TaskSummary } from '../../core/api/types';
import { attentionReason, isActive, isQueued } from '../../core/util/task-health';

/** One row on the Repositories page, derived from the tasks the API returns. */
export interface RepoSummary {
  readonly repo: string;
  readonly working: number;
  readonly needsYou: number;
  readonly done: number;
  readonly failed: number;
  readonly total: number;
  /** Most recent update across the repository's tasks. */
  readonly lastActivity: string;
}

export function summarizeRepos(tasks: readonly TaskSummary[], now: Date = new Date()): RepoSummary[] {
  const byRepo = new Map<string, TaskSummary[]>();
  for (const task of tasks) {
    if (!task.repo) continue;
    byRepo.set(task.repo, [...(byRepo.get(task.repo) ?? []), task]);
  }
  return [...byRepo.entries()]
    .map(([repo, list]) => ({
      repo,
      working: list.filter((t) => isActive(t.status) || isQueued(t.status)).length,
      needsYou: list.filter((t) => attentionReason(t, now) !== null).length,
      done: list.filter((t) => t.status === 'COMPLETED').length,
      failed: list.filter((t) => ['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(t.status)).length,
      total: list.length,
      lastActivity: list.map((t) => t.updated_at).sort().at(-1) ?? '',
    }))
    .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));
}
