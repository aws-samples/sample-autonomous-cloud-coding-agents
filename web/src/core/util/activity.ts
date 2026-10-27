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

import type { TaskEvent } from '../api/types';

/**
 * Turns raw task events into short, plain-English lines ("Edited src/app.ts").
 * Bookkeeping events (turn counters, cost ticks, setup internals) return null:
 * they stay in the full log but never reach the activity feed.
 */

export type ActivityKind = 'action' | 'said' | 'step' | 'message' | 'problem';

export interface ActivityLine {
  readonly id: string;
  readonly at: string;
  readonly kind: ActivityKind;
  readonly text: string;
  /** Optional code-ish detail shown in monospace, e.g. the command that ran. */
  readonly detail?: string;
}

function str(meta: Record<string, unknown>, key: string): string | null {
  const v = meta[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Reads one field from a tool-input preview. Previews are a truncated Python-style
 * dict repr (`{'command': "ls -a", 'description': 'List files'}`), so this is a
 * best-effort match that tolerates either quote style and a cut-off tail.
 */
export function previewField(preview: string | null, key: string): string | null {
  if (!preview) return null;
  for (const quote of ["'", '"']) {
    let at = preview.indexOf(`${quote}${key}${quote}`);
    while (at >= 0) {
      let i = at + key.length + 2;
      while (preview[i] === ' ') i += 1;
      if (preview[i] === ':') {
        i += 1;
        while (preview[i] === ' ') i += 1;
        const open = preview[i];
        if (open === "'" || open === '"') return readQuoted(preview, i + 1, open);
      }
      at = preview.indexOf(`${quote}${key}${quote}`, at + 1);
    }
  }
  return null;
}

/** Reads a quoted value starting after its opening quote; null when the preview was cut off first. */
function readQuoted(text: string, start: number, quote: string): string | null {
  let out = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      out += text[i + 1];
      i += 1;
    } else if (ch === quote) {
      return out;
    } else {
      out += ch;
    }
  }
  return null;
}

/** Shows a path relative to the repository when possible: `/workspace/acme/api/src/a.ts` → `src/a.ts`. */
export function displayPath(path: string, repo?: string | null): string {
  const name = repo?.split('/')[1];
  if (name) {
    const marker = `/${name}/`;
    const at = path.lastIndexOf(marker);
    if (at >= 0) return path.slice(at + marker.length);
  }
  const parts = path.split('/').filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join('/') : parts.join('/');
}

function shorten(text: string, max = 90): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toolAction(meta: Record<string, unknown>, repo?: string | null): Pick<ActivityLine, 'text' | 'detail'> | null {
  const tool = str(meta, 'tool_name');
  const preview = str(meta, 'tool_input_preview');
  const file = previewField(preview, 'file_path') ?? previewField(preview, 'path');
  switch (tool) {
    case 'Bash': {
      const description = previewField(preview, 'description');
      const command = previewField(preview, 'command');
      if (description) return { text: sentence(description), ...(command ? { detail: shorten(command, 120) } : {}) };
      return { text: 'Ran a command', ...(command ? { detail: shorten(command, 120) } : {}) };
    }
    case 'Read':
      return { text: file ? `Read ${displayPath(file, repo)}` : 'Read a file' };
    case 'Edit':
    case 'MultiEdit':
      return { text: file ? `Edited ${displayPath(file, repo)}` : 'Edited a file' };
    case 'Write':
      return { text: file ? `Wrote ${displayPath(file, repo)}` : 'Wrote a file' };
    case 'Grep': {
      const pattern = previewField(preview, 'pattern');
      return { text: pattern ? `Searched the code for "${shorten(pattern, 40)}"` : 'Searched the code' };
    }
    case 'Glob':
      return { text: 'Looked for files' };
    case 'WebFetch': {
      const url = previewField(preview, 'url');
      return { text: url ? `Opened ${shorten(url, 60)}` : 'Opened a web page' };
    }
    case null:
      return null;
    default:
      return { text: `Used ${tool}` };
  }
}

/** Short, recognizable tail of a nudge id, matching what the agent reports back (`ids=…a1b2c3d4`). */
export function nudgeIdTail(nudgeId: string): string {
  return nudgeId.slice(-8);
}

function milestone(meta: Record<string, unknown>): Pick<ActivityLine, 'text' | 'kind' | 'detail'> | null {
  const name = str(meta, 'milestone') ?? '';
  const details = str(meta, 'details') ?? '';
  if (name === 'repo_setup_complete') {
    const branch = /branch=(\S+)/.exec(details)?.[1];
    return { kind: 'step', text: 'Copied the repository and made a working branch', ...(branch ? { detail: branch } : {}) };
  }
  if (name === 'pr_created') return { kind: 'step', text: 'Opened the pull request' };
  if (name === 'nudge_acknowledged') {
    const message = /\):\s*(.*)$/s.exec(details)?.[1];
    return { kind: 'message', text: message ? `Read your message: "${shorten(message, 80)}"` : 'Read your message' };
  }
  if (name === 'approval_granted') return { kind: 'step', text: 'Got your OK and carried on' };
  if (name === 'approval_denied') return { kind: 'problem', text: 'You said no, so it skipped that action' };
  if (name === 'approval_timed_out') return { kind: 'problem', text: 'Nobody answered the approval request in time' };

  const step = /^step:([^:]+):(start|succeeded|failed)$/.exec(name);
  if (step) {
    const [, key, phase] = step;
    const area = stepArea(key);
    if (phase === 'start') {
      if (area === 'working') return { kind: 'step', text: 'Started on the change' };
      if (area === 'checking') return { kind: 'step', text: 'Checking that it builds and the tests pass' };
      if (area === 'pull-request') return { kind: 'step', text: 'Opening a pull request' };
      return null;
    }
    if (phase === 'failed') return { kind: 'problem', text: area === 'checking' ? 'The build or tests failed' : `Step "${key}" failed` };
    if (area === 'checking') return { kind: 'step', text: 'Build and tests passed' };
  }
  return null;
}

/** Which of the five progress steps a workflow step name belongs to. */
export type StepArea = 'setting-up' | 'working' | 'checking' | 'pull-request';

export function stepArea(stepName: string): StepArea {
  const key = stepName.toLowerCase();
  if (/(^|_)(pr|pull_request|deliver|publish|push)($|_)/.test(key)) return 'pull-request';
  if (/build|verify|test|lint|check/.test(key)) return 'checking';
  if (/setup|clone|context|hydrate|prepare/.test(key)) return 'setting-up';
  return 'working';
}

export function describeEvent(event: TaskEvent, repo?: string | null): ActivityLine | null {
  const meta = event.metadata ?? {};
  const base = { id: event.event_id, at: event.timestamp };
  switch (event.event_type) {
    case 'task_created':
      return { ...base, kind: 'step', text: 'Task created' };
    case 'agent_milestone': {
      const line = milestone(meta);
      return line ? { ...base, ...line } : null;
    }
    case 'agent_tool_call': {
      const line = toolAction(meta, repo);
      return line ? { ...base, kind: 'action', ...line } : null;
    }
    case 'agent_turn': {
      const said = str(meta, 'text_preview');
      return said ? { ...base, kind: 'said', text: shorten(said, 240) } : null;
    }
    case 'agent_blocked':
      return { ...base, kind: 'problem', text: str(meta, 'remediation_hint') ?? 'It got stuck and could not continue' };
    case 'approval_requested':
      return { ...base, kind: 'problem', text: `Asked for your OK: ${str(meta, 'reason') ?? 'an action needs approval'}` };
    case 'task_failed':
      return { ...base, kind: 'problem', text: str(meta, 'reason') ? `Stopped: ${str(meta, 'reason')}` : 'Stopped with an error' };
    case 'task_completed':
      return { ...base, kind: 'step', text: 'Finished' };
    case 'task_cancelled':
      return { ...base, kind: 'step', text: 'Cancelled' };
    default:
      return null;
  }
}

/** Oldest first, bookkeeping removed. Accepts events in any order. */
export function activityFeed(events: readonly TaskEvent[], repo?: string | null): ActivityLine[] {
  return [...events]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id))
    .map((e) => describeEvent(e, repo))
    .filter((line): line is ActivityLine => line !== null);
}
