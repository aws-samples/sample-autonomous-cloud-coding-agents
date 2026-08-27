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

import {
  BOT_NOTE_PREFIX,
  renderEpicAlreadyCompleteNote,
  renderEpicRetryNote,
  renderLabelHelp,
  renderNoLinkedTaskNudge,
  renderTaskLookupFailedNudge,
  renderWrongMentionNudge,
} from '../../../src/handlers/shared/linear-notes';
import { isBotAuthoredComment } from '../../../src/handlers/shared/orchestration-comment-trigger';

describe('the nudges posted when a mention cannot be acted on', () => {
  test('the wrong-handle nudge names the right handle, so the reviewer can re-send', () => {
    const md = renderWrongMentionNudge();
    expect(md).toContain('@bgagent');
    // Bot-authored (👋-prefixed) so parseCommentTrigger/detectNearMissMention skip it —
    // without this, posting the nudge would trigger the bot on its own comment.
    expect(isBotAuthoredComment(md)).toBe(true);
    // Steers the reviewer to re-send mentioning the right handle.
    expect(md).toMatch(/re-?send|mention/i);
    // The mistake that lands here most often is treating the trigger label as a
    // handle, so the nudge says outright that it isn't one.
    expect(md).toMatch(/label isn't a mention handle/i);
  });

  test('an issue with no linked task is told so, and pointed at the way forward', () => {
    // Reaching this path takes an explicit @bgagent mention, so the user is waiting.
    // Saying only "nothing to iterate on" would leave them with no next step; the
    // trigger label starts a fresh run, which is the actual way forward.
    const md = renderNoLinkedTaskNudge();
    expect(md).toMatch(/don't have a task linked to this issue/i);
    expect(md).toMatch(/re-apply this project's trigger label/i);
    expect(isBotAuthoredComment(md)).toBe(true);
  });

  test('a FAILED lookup does not claim the issue is not ours — that would be a guess', () => {
    // A Query failure and a genuine miss are different facts. Reporting the first
    // as the second states a conclusion we cannot draw, and hides a real fault.
    const md = renderTaskLookupFailedNudge();
    expect(md).toMatch(/couldn't look up/i);
    expect(md).toMatch(/transient fault on my side/i);
    expect(md).not.toMatch(/don't have a task linked/i);
    // Names a concrete retry, so the reviewer isn't left waiting on nothing.
    expect(md).toContain('@bgagent');
    expect(isBotAuthoredComment(md)).toBe(true);
  });
});

describe('renderLabelHelp — the one-time label explainer', () => {
  test('explains the trigger label in plain English and is bot-authored', () => {
    const md = renderLabelHelp('bgagent');
    expect(md).toContain('`bgagent`');
    // Plain-English intent words, not internal jargon.
    expect(md).toMatch(/pull request/i);
    expect(md).toMatch(/how to use abca/i);
    // Self-trigger guard: our own comment must be recognised as bot-authored.
    expect(isBotAuthoredComment(md)).toBe(true);
  });

  test('uses the project custom base label for the LABEL it names', () => {
    const md = renderLabelHelp('ship');
    expect(md).toContain('`ship`');
    expect(md).not.toContain('`bgagent`');
  });

  test('the reply MENTION is always @bgagent (the app handle), even under a custom label base', () => {
    // The trigger LABEL is renameable (base = 'ship'), but the reply MENTION is
    // the Linear app's actor handle — fixed at @bgagent and the only token the
    // comment trigger fires on. The help used to say `@ship`, which never worked.
    const md = renderLabelHelp('ship');
    expect(md).toContain('`@bgagent <what you want>`');
    expect(md).not.toMatch(/@ship\b/); // must NOT promise a mention that doesn't fire
  });

  test('names the retry command, since a partly-failed epic is where users get stuck', () => {
    const md = renderLabelHelp('bgagent');
    expect(md).toContain('`@bgagent retry`');
    expect(md).toMatch(/keeps the parts that succeeded/i);
  });

  test('says an issue with sub-issues runs those, so a parent label is not a surprise', () => {
    const md = renderLabelHelp('bgagent');
    expect(md).toMatch(/already has sub-issues/i);
    expect(md).toMatch(/dependency order/i);
  });
});

describe('renderEpicRetryNote / renderEpicAlreadyCompleteNote — re-triggering an epic', () => {
  test('retry note names exactly what is being re-run (failed + skipped) + keeps succeeded', () => {
    const note = renderEpicRetryNote({ failed: 2, skipped: 3, succeeded: 1 });
    expect(note.startsWith(BOT_NOTE_PREFIX)).toBe(true);
    expect(note).toMatch(/Re-running/i);
    expect(note).toContain('5 sub-issues'); // 2 + 3
    expect(note).toContain('2 failed');
    expect(note).toContain('3 skipped');
    expect(note).toMatch(/1 that already succeeded is left as-is/);
    // NOT the misleading "running the existing sub-issue graph".
    expect(note).not.toMatch(/running the existing sub-issue graph/);
  });

  test('retry note omits the succeeded clause when none succeeded, pluralizes correctly', () => {
    const note = renderEpicRetryNote({ failed: 1, skipped: 0, succeeded: 0 });
    expect(note).toContain('1 sub-issue ('); // singular
    expect(note).toContain('1 failed');
    expect(note).not.toContain('skipped');
    expect(note).not.toMatch(/left as-is/);
  });

  test('already-complete note says nothing to re-run + points at per-sub-issue comments', () => {
    const note = renderEpicAlreadyCompleteNote();
    expect(note).toMatch(/already finished/i);
    expect(note).toMatch(/nothing to re-run/i);
    expect(note).toMatch(/@bgagent/);
    expect(note).not.toMatch(/running the existing sub-issue graph/);
  });

  test('both re-trigger notes are bot-authored (never self-trigger)', () => {
    expect(isBotAuthoredComment(renderEpicRetryNote({ failed: 1, skipped: 1, succeeded: 0 }))).toBe(true);
    expect(isBotAuthoredComment(renderEpicAlreadyCompleteNote())).toBe(true);
  });
});
