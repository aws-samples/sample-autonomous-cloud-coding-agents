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

const NONE = '-';

/** "5s ago", "3m ago", "2h ago", "4d ago"; future times read "in 3m". */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return NONE;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return NONE;
  const deltaS = Math.round((now.getTime() - then) / 1000);
  const label = formatSpan(Math.abs(deltaS));
  return deltaS >= 0 ? `${label} ago` : `in ${label}`;
}

/** Elapsed seconds as "45s", "12m 3s", "2h 5m". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return NONE;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return NONE;
  return `$${usd.toFixed(2)}`;
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return NONE;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? NONE : date.toLocaleString();
}

/** Task ids are ULIDs; the last 8 characters are enough to tell rows apart. */
export function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

function formatSpan(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/**
 * What a person would call the task: the issue's title, else its description, else
 * the issue number. With an issue, the description is only extra guidance.
 */
export function taskTitle(task: {
  readonly task_description: string | null;
  readonly issue_number: number | null;
  readonly issue_title?: string | null;
}): string {
  const issueTitle = task.issue_title?.trim();
  if (task.issue_number && issueTitle) return issueTitle;
  const description = task.task_description?.trim();
  if (description) return description;
  return task.issue_number ? `Fix issue #${task.issue_number}` : 'Untitled task';
}

/** Route for a repository's page; `owner/name` maps onto two path segments. */
export function repoHref(repo: string): string {
  return `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;
}

export function taskHref(taskId: string): string {
  return `/tasks/${encodeURIComponent(taskId)}`;
}
