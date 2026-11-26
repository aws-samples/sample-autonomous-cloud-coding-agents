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
 * Task progress → Linear agent-session activities (ADR-018, #1066).
 *
 * The session already shows the acknowledgement, the PR, a throttled keep-alive and the
 * final outcome (fanout-task-events.ts). This maps the events in between onto
 * activities, so a run is visible while it happens:
 *
 *  - the agent's own messages become persistent thoughts;
 *  - tool calls become an ephemeral action: the "currently doing" line, replaced
 *    by the next one rather than stacking up;
 *  - platform steps (queued, sandbox, context, clone) and agent milestones become
 *    persistent steps, except the queue and sandbox lines, which are ephemeral.
 *
 * Pure: no I/O. The dispatcher decides what to emit, caps the persistent ones per task
 * and keeps them idempotent.
 */

import { createHash } from 'node:crypto';
import type { AgentActivityContent } from './linear-agent-session';

/** One activity to emit; ephemeral ones are replaced by the session's next activity. */
export interface SessionProgressActivity {
  readonly content: AgentActivityContent;
  readonly ephemeral: boolean;
}

/**
 * Event types (as routed: an agent_milestone carries its milestone name) that matter
 * only to agent sessions. The comment path ignores them, and the fan-out counts them
 * apart from the events every channel needs, so a burst of them never pushes a PR or a
 * terminal event out of a batch.
 */
export const LINEAR_SESSION_PROGRESS_EVENTS: ReadonlySet<string> = new Set([
  'agent_turn',
  'agent_tool_call',
  'admission_queued',
  'hydration_complete',
  'repo_setup_complete',
  'nudge_acknowledged',
  'attachments_downloaded',
  'agent_execution_complete',
]);

/** Milestones the session uses; each must also be routable by name (ROUTABLE_MILESTONES). */
export const LINEAR_SESSION_PROGRESS_MILESTONES: readonly string[] = [
  'repo_setup_complete',
  'nudge_acknowledged',
  'attachments_downloaded',
  // No activity of its own: it moves the session checklist to "Open the pull request".
  'agent_execution_complete',
];

const THOUGHT_MAX = 600;
const TOOL_PARAMETER_MAX = 120;
const BRANCH_MAX = 80;
/** A digest's hex digits as a UUID's fields, skipping the version and variant nibbles. */
const UUID_FIELDS = /^(.{8})(.{4}).(.{3}).(.{3})(.{12})/;

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** `k=v k=v` milestone details → a map (values without spaces). */
function parseDetails(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof details !== 'string') return out;
  for (const m of details.matchAll(/(\w+)=(\S+)/g)) out[m[1]] = m[2];
  return out;
}

/**
 * A `'key': 'value'` pair of a tool-input preview: the agent writes the input dict's
 * Python repr (`{'file_path': '...'}`), cut at a fixed length. Key and value quote
 * independently, because repr switches a value to double quotes when it holds a
 * single quote. A match consumes its whole value, so text inside a value is never
 * read as a key.
 */
const INPUT_FIELD = /['"](\w+)['"]\s*:\s*(['"])((?:(?!\2)[^\\]|\\.)*)/g;

/** The first non-empty string value among `keys`, in that order of preference. */
function inputField(preview: unknown, keys: readonly string[]): string | undefined {
  if (typeof preview !== 'string' || preview.length === 0) return undefined;
  const values = new Map<string, string>();
  for (const [, key, , value] of preview.matchAll(INPUT_FIELD)) {
    if (value && !values.has(key)) values.set(key, value);
  }
  const value = keys.map((k) => values.get(k)).find((v) => v !== undefined);
  return value?.replace(/\\(['"])/g, '$1').replace(/\\n/g, ' ');
}

const WORKSPACE_PREFIX = /\/workspace\/[^/\s'"]+\/?/g;

/** `/workspace/<task-id>/src/app.ts` → `src/app.ts`. */
function repoRelative(p: string): string {
  return p.replace(WORKSPACE_PREFIX, '');
}

/** `cd /workspace/<task-id>; npm test` → `npm test`. */
function readableCommand(cmd: string): string {
  return cmd.replace(/^\s*cd\s+\/workspace\/[^\s;&]+\s*(?:;|&&)\s*/, '').replace(WORKSPACE_PREFIX, '');
}

const TOOL_VERBS: Readonly<Record<string, { readonly action: string; readonly keys: readonly string[]; readonly path?: boolean }>> = {
  Read: { action: 'Reading', keys: ['file_path', 'path'], path: true },
  Edit: { action: 'Editing', keys: ['file_path'], path: true },
  MultiEdit: { action: 'Editing', keys: ['file_path'], path: true },
  Write: { action: 'Writing', keys: ['file_path'], path: true },
  NotebookEdit: { action: 'Editing', keys: ['notebook_path'], path: true },
  Bash: { action: 'Running', keys: ['command'] },
  Grep: { action: 'Searching', keys: ['pattern'] },
  Glob: { action: 'Finding files', keys: ['pattern'] },
  WebFetch: { action: 'Fetching', keys: ['url'] },
  WebSearch: { action: 'Searching the web', keys: ['query'] },
  Task: { action: 'Delegating', keys: ['description'] },
  TodoWrite: { action: 'Updating its plan', keys: [] },
};

function toolActivity(meta: Record<string, unknown>): SessionProgressActivity | null {
  const tool = typeof meta.tool_name === 'string' ? meta.tool_name : '';
  if (!tool) return null;
  const verb = TOOL_VERBS[tool];
  if (!verb) {
    // An MCP or unknown tool: name it, without guessing at its input.
    return { content: { type: 'action', action: `Using ${clip(tool, TOOL_PARAMETER_MAX)}`, parameter: '' }, ephemeral: true };
  }
  const raw = inputField(meta.tool_input_preview, verb.keys);
  const value = raw === undefined ? '' : verb.path ? repoRelative(raw) : readableCommand(raw);
  const parameter = value ? `\`${clip(value, TOOL_PARAMETER_MAX).replace(/`/g, "'")}\`` : '';
  return { content: { type: 'action', action: verb.action, parameter }, ephemeral: true };
}

function milestoneActivity(name: string, details: unknown): SessionProgressActivity | null {
  const d = parseDetails(details);
  switch (name) {
    case 'repo_setup_complete':
      return {
        content: { type: 'action', action: 'Cloned the repository', parameter: d.branch ? `on branch \`${clip(d.branch, BRANCH_MAX)}\`` : '' },
        ephemeral: false,
      };
    case 'attachments_downloaded':
      return { content: { type: 'action', action: 'Read the issue attachments', parameter: d.count ? `${d.count} file(s)` : '' }, ephemeral: false };
    case 'nudge_acknowledged':
      return { content: { type: 'thought', body: 'Picked up your message and working it in.' }, ephemeral: false };
    default:
      return null;
  }
}

/**
 * The activity for one progress event, or null when it has nothing to show.
 * @param effectiveType - the routed type (an `agent_milestone` carries its milestone name).
 * @param metadata - the event's metadata.
 */
export function sessionProgressActivity(
  effectiveType: string,
  metadata: Record<string, unknown> | undefined,
): SessionProgressActivity | null {
  const meta = metadata ?? {};
  switch (effectiveType) {
    case 'agent_turn': {
      const text = typeof meta.text_preview === 'string' ? meta.text_preview.trim() : '';
      return text ? { content: { type: 'thought', body: clip(text, THOUGHT_MAX) }, ephemeral: false } : null;
    }
    case 'agent_tool_call':
      return toolActivity(meta);
    case 'admission_queued': {
      // Ephemeral: the admission reconciler re-emits it with `waited_s` while the task
      // waits, which also keeps a long wait from turning the session stale.
      const waitedMin = Math.round(Number(meta.waited_s) / 60);
      const lead = Number.isFinite(waitedMin) && waitedMin > 0 ? `Still queued (${waitedMin} min so far)` : 'Queued';
      return {
        content: { type: 'thought', body: `${lead}: you already have the maximum number of tasks running. This one starts as soon as one finishes.` },
        ephemeral: true,
      };
    }
    case 'hydration_complete':
      return { content: { type: 'action', action: 'Gathered the issue context', parameter: '' }, ephemeral: false };
    default:
      return milestoneActivity(effectiveType, meta.details);
  }
}

/**
 * A deterministic activity id for an event, so a redelivered or re-run record emits the
 * same activity rather than a second one. Linear accepts only version-4 UUIDs, so the
 * hash gets the v4 version and variant bits.
 * @param seed - unique per activity (the task event id).
 */
export function progressActivityId(seed: string): string {
  const hex = createHash('sha256').update(`linear-session-progress:${seed}`).digest('hex');
  const [, a, b, c, d, e] = UUID_FIELDS.exec(hex)!;
  return `${a}-${b}-4${c}-a${d}-${e}`;
}
