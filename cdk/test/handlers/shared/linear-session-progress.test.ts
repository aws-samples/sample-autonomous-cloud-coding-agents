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

import { progressActivityId, sessionProgressActivity } from '../../../src/handlers/shared/linear-session-progress';

describe('sessionProgressActivity (#1066)', () => {
  test('tool calls are an ephemeral "currently doing" line with a readable input', () => {
    // The agent's tool_input_preview is the input dict's Python repr, cut at a fixed length.
    expect(sessionProgressActivity('agent_tool_call', { tool_name: 'Read', tool_input_preview: "{'file_path': '/workspace/t-1/src/app.ts'}" }))
      .toEqual({ content: { type: 'action', action: 'Reading', parameter: '`src/app.ts`' }, ephemeral: true });
    expect(sessionProgressActivity('agent_tool_call', { tool_name: 'Bash', tool_input_preview: "{'command': 'cd /workspace/t-1; npm test', 'description'" }))
      .toEqual({ content: { type: 'action', action: 'Running', parameter: '`npm test`' }, ephemeral: true });
    // repr switches a value to double quotes when it contains a single quote.
    expect(sessionProgressActivity('agent_tool_call', { tool_name: 'Grep', tool_input_preview: "{'pattern': \"don't\"}" })?.content)
      .toEqual({ type: 'action', action: 'Searching', parameter: "`don't`" });
    // An MCP or unknown tool is named, and its input is not guessed at.
    expect(sessionProgressActivity('agent_tool_call', { tool_name: 'mcp__gateway__lookup', tool_input_preview: '{}' })?.content)
      .toEqual({ type: 'action', action: 'Using mcp__gateway__lookup', parameter: '' });
    expect(sessionProgressActivity('agent_tool_call', {})).toBeNull();
  });

  test("the agent's own message is a persistent thought; a turn without text is nothing", () => {
    expect(sessionProgressActivity('agent_turn', { text_preview: '  I found the bug in  the parser.  ' }))
      .toEqual({ content: { type: 'thought', body: 'I found the bug in the parser.' }, ephemeral: false });
    expect((sessionProgressActivity('agent_turn', { text_preview: 'x'.repeat(2000) })?.content as { body: string }).body).toHaveLength(600);
    expect(sessionProgressActivity('agent_turn', { text_preview: '   ', thinking_preview: 'private' })).toBeNull();
  });

  test('queueing is ephemeral and says how long the task has waited', () => {
    expect(sessionProgressActivity('admission_queued', { reason: 'concurrency_limit' })?.content)
      .toMatchObject({ type: 'thought', body: expect.stringMatching(/^Queued: /) });
    const still = sessionProgressActivity('admission_queued', { waited_s: 1800 });
    expect(still?.ephemeral).toBe(true);
    expect((still?.content as { body: string }).body).toMatch(/^Still queued \(30 min so far\): /);
  });

  test('platform steps and agent milestones are persistent steps', () => {
    expect(sessionProgressActivity('hydration_complete', {})).toEqual({
      content: { type: 'action', action: 'Gathered the issue context', parameter: '' }, ephemeral: false,
    });
    expect(sessionProgressActivity('repo_setup_complete', { details: 'branch=bgagent/t-1/fix-parser build_before=pass' })?.content)
      .toEqual({ type: 'action', action: 'Cloned the repository', parameter: 'on branch `bgagent/t-1/fix-parser`' });
    expect(sessionProgressActivity('attachments_downloaded', { details: 'count=2' })?.content)
      .toEqual({ type: 'action', action: 'Read the issue attachments', parameter: '2 file(s)' });
    expect(sessionProgressActivity('nudge_acknowledged', {})?.content).toEqual({ type: 'thought', body: 'Picked up your message and working it in.' });
    expect(sessionProgressActivity('trajectory_uploaded', {})).toBeNull();
  });

  test('activity ids are deterministic version-4 UUIDs (Linear rejects other versions)', () => {
    const id = progressActivityId('evt-1');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(progressActivityId('evt-1')).toBe(id);
    expect(progressActivityId('evt-2')).not.toBe(id);
  });
});
