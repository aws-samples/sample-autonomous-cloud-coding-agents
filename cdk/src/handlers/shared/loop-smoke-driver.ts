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

/**
 * Pure PARSING layer for the Phase-1 loop-smoke driver.
 *
 * The live driver shells the `bgagent` CLI:
 *   - `bgagent submit --repo … --task … --output json`  → a single JSON TaskDetail
 *   - `bgagent watch <id> --output json`                → NDJSON (one TaskEvent per line)
 * and resolves the opened PR's base branch via the GitHub API. All of that raw
 * I/O lives in the thin untestable runner; THIS module turns the raw stdout
 * strings + the resolved base branch into the {@link LoopSmokeInput} that the
 * (already-tested) verifier consumes. Keeping the parse pure means the fiddly
 * bits — NDJSON with blank/garbage lines, a pretty-printed submit blob, a PR URL
 * → owner/repo/number split — are all unit-tested with fixture strings, and only
 * `execFile`/`fetch` are left uncovered.
 */

import type { LoopEvent, LoopSmokeInput, LoopTaskSnapshot } from './loop-smoke-assert';

/** The subset of the `bgagent submit --output json` TaskDetail we consume. */
export interface SubmitResult {
  readonly taskId: string;
  readonly status: string;
  readonly prUrl?: string | null;
}

/**
 * Parse the stdout of `bgagent submit --output json`. The CLI prints the
 * TaskDetail via `formatJson` (pretty-printed, multi-line), so the WHOLE stdout
 * is one JSON object — parse it as such (not line-by-line). Throws a clear error
 * if stdout isn't valid JSON or is missing `task_id`, so a CLI/output-shape
 * regression fails loudly at parse time rather than as a mysterious later
 * assertion miss.
 */
export function parseSubmitOutput(stdout: string): SubmitResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('bgagent submit produced no stdout — cannot resolve task_id');
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    throw new Error(
      `bgagent submit stdout is not valid JSON (did you pass --output json?): ${trimmed.slice(0, 200)}`,
    );
  }
  const taskId = obj.task_id;
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error(`bgagent submit JSON has no task_id: ${trimmed.slice(0, 200)}`);
  }
  return {
    taskId,
    status: typeof obj.status === 'string' ? obj.status : 'UNKNOWN',
    prUrl: typeof obj.pr_url === 'string' ? obj.pr_url : null,
  };
}

/**
 * Parse the NDJSON stdout of `bgagent watch <id> --output json` into ordered
 * {@link LoopEvent}s. Blank lines are skipped; a line that isn't valid JSON is
 * skipped too (the CLI writes INFO logs to STDERR, so stdout should be pure
 * NDJSON — but be defensive so one stray line can't crash the whole verify).
 * Order is preserved as-emitted (the feed is already chronological by ULID).
 */
export function parseWatchNdjson(stdout: string): LoopEvent[] {
  const events: LoopEvent[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // not a JSON event line — skip defensively
    }
    if (obj && typeof obj === 'object' && typeof (obj as LoopEvent).event_type === 'string') {
      const e = obj as { event_type: string; metadata?: Record<string, unknown> };
      events.push({ event_type: e.event_type, metadata: e.metadata });
    }
  }
  return events;
}

/** A parsed GitHub PR reference. */
export interface PrRef {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * Parse a GitHub PR URL (`https://github.com/<owner>/<repo>/pull/<n>`) into its
 * parts, so the runner can query the GitHub API for the PR's base branch and
 * later close it during cleanup. Returns null for a non-PR / unparseable URL
 * (the base-branch check then SKIPs rather than fails — see the verifier).
 */
export function parsePrUrl(prUrl: string | null | undefined): PrRef | null {
  if (!prUrl) return null;
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl.trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}

/**
 * Assemble the {@link LoopSmokeInput} for the verifier from the raw pieces the
 * runner collected. `prBaseBranch` is what the runner resolved from the GitHub
 * API (or null/undefined if it couldn't) — passed straight through so the
 * verifier's SKIP-not-pass logic governs the base-branch check.
 */
export function buildLoopSmokeInput(args: {
  events: LoopEvent[];
  finalStatus: string;
  prUrl?: string | null;
  prBaseBranch?: string | null;
  expectedBaseBranch?: string;
}): LoopSmokeInput {
  const task: LoopTaskSnapshot = {
    status: args.finalStatus,
    pr_url: args.prUrl ?? null,
    pr_base_branch: args.prBaseBranch ?? null,
  };
  return {
    events: args.events,
    task,
    expectedBaseBranch: args.expectedBaseBranch,
  };
}
