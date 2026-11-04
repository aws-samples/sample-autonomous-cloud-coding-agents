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

import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '../../../src/core/api/types';
import { activityFeed, describeEvent, displayPath, previewField, stepArea } from '../../../src/core/util/activity';

function ev(event_type: string, metadata: Record<string, unknown> = {}, timestamp = '2026-10-27T17:22:00Z'): TaskEvent {
  return { event_id: `e-${event_type}-${timestamp}`, event_type, timestamp, metadata };
}

const call = (tool_name: string, tool_input_preview: string) => describeEvent(ev('agent_tool_call', { tool_name, tool_input_preview }), 'acme/game');

describe('previewField', () => {
  it('reads fields from the agent\'s dict-style preview, either quote style', () => {
    const preview = `{'command': "ls -a && grep 'x' f", 'description': 'Show existing CODEOWNERS and history'}`;
    expect(previewField(preview, 'command')).toBe("ls -a && grep 'x' f");
    expect(previewField(preview, 'description')).toBe('Show existing CODEOWNERS and history');
  });

  it('returns null for a field cut off by truncation', () => {
    expect(previewField(`{'command': 'ls', 'descripti...`, 'description')).toBeNull();
  });
});

describe('describeEvent', () => {
  it('uses the agent\'s own description of a command', () => {
    expect(call('Bash', `{'command': 'npm test', 'description': 'run the tests'}`)).toMatchObject({ text: 'Run the tests', detail: 'npm test' });
  });

  it('falls back to "Ran a command" when the description was truncated away', () => {
    expect(call('Bash', `{'command': 'ls -a && find . -name CODEOWNERS', 'descr...`)).toMatchObject({ text: 'Ran a command' });
  });

  it('names files relative to the repository', () => {
    expect(call('Edit', `{'file_path': '/workspace/acme/game/src/world.ts', 'old_string': 'x'}`)?.text).toBe('Edited src/world.ts');
    expect(call('Read', `{'file_path': '/tmp/a/b/c/d.ts'}`)?.text).toBe('Read b/c/d.ts');
    expect(call('Write', '')?.text).toBe('Wrote a file');
    expect(call('Grep', `{'pattern': 'inBounds'}`)?.text).toBe('Searched the code for "inBounds"');
  });

  it('quotes what the agent said, and hides empty turns', () => {
    expect(describeEvent(ev('agent_turn', { turn: 2, text_preview: 'A CODEOWNERS file already exists.' }))).toMatchObject({ kind: 'said', text: 'A CODEOWNERS file already exists.' });
    expect(describeEvent(ev('agent_turn', { turn: 3, text_preview: '' }))).toBeNull();
  });

  it('translates milestones and hides bookkeeping', () => {
    expect(describeEvent(ev('agent_milestone', { milestone: 'repo_setup_complete', details: 'branch=bgagent/x/y build_before=True' })))
      .toMatchObject({ text: 'Copied the repository and made a working branch', detail: 'bgagent/x/y' });
    expect(describeEvent(ev('agent_milestone', { milestone: 'step:build:failed' }))).toMatchObject({ kind: 'problem', text: 'The build or tests failed' });
    for (const hidden of ['pre_approvals_loaded', 'agent_execution_complete', 'step:implement:succeeded', 'trajectory_uploaded']) {
      expect(describeEvent(ev('agent_milestone', { milestone: hidden }))).toBeNull();
    }
    for (const type of ['hydration_started', 'hydration_complete', 'session_started', 'agent_cost_update', 'agent_tool_result']) {
      expect(describeEvent(ev(type))).toBeNull();
    }
  });

  it('shows the message the agent read', () => {
    expect(describeEvent(ev('agent_milestone', { milestone: 'nudge_acknowledged', details: '1 nudge(s) acknowledged (ids=…abcd1234): add a test' })))
      .toMatchObject({ kind: 'message', text: 'Read your message: "add a test"' });
  });
});

describe('stepArea', () => {
  it('maps workflow step names onto the five steps', () => {
    expect(stepArea('setup')).toBe('setting-up');
    expect(stepArea('prepare')).toBe('setting-up');
    expect(stepArea('implement')).toBe('working');
    expect(stepArea('build')).toBe('checking');
    expect(stepArea('open_pr')).toBe('pull-request');
  });
});

describe('activityFeed', () => {
  it('orders oldest first and drops hidden events', () => {
    const lines = activityFeed([
      ev('agent_tool_call', { tool_name: 'Glob' }, '2026-10-27T17:23:00Z'),
      ev('agent_cost_update', { cost_usd: 1 }, '2026-10-27T17:22:30Z'),
      ev('task_created', {}, '2026-10-27T17:22:00Z'),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['Task created', 'Looked for files']);
  });

  it('displayPath keeps short paths whole', () => {
    expect(displayPath('src/a.ts')).toBe('src/a.ts');
  });
});
