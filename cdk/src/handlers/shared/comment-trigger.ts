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

/** The explicit mention that turns a channel comment into an instruction. */
export const COMMENT_TRIGGER_MENTION = '@bgagent';

export interface CommentTrigger {
  readonly triggered: boolean;
  readonly instruction: string;
}

/**
 * Parse a channel-neutral `@bgagent` comment trigger.
 *
 * The token match is case-insensitive and rejects handle/email prefixes such
 * as `@bgagentbot` and `foo@bgagent.io`. All mention occurrences are removed
 * from the instruction. A bare mention remains a valid trigger; callers can
 * supply workflow-specific fallback text.
 */
export function parseCommentTrigger(body: string | undefined | null): CommentTrigger {
  if (!body || isKnownAbcaComment(body)) {
    return { triggered: false, instruction: '' };
  }

  const mention = /(?<![\w.])@bgagent(?![\w.])/gi;
  if (!mention.test(body)) {
    return { triggered: false, instruction: '' };
  }

  return {
    triggered: true,
    instruction: body
      .replace(/(?<![\w.])@bgagent(?![\w.])/gi, ' ')
      .replace(/[^\S\r\n]+/g, ' ')
      .replace(/ *\r?\n */g, '\n')
      .trim(),
  };
}

/**
 * ABCA-authored Jira comments use stable leading markers. Reject them before
 * mention parsing so rendered help/examples can never create a self-trigger
 * loop. Jira comments posted through 3LO are attributed to the authorizing
 * Atlassian user rather than an app account, so author.accountType alone is
 * insufficient as a loop guard.
 */
export function isKnownAbcaComment(body: string): boolean {
  const prefixes = [
    '🤖 ABCA ',
    '✅ Task completed',
    '❌ Task ',
    '❌ ABCA ',
    '⚠️ Shipped a PR but stopped early',
    '👀 ABCA ',
  ];
  const trimmed = body.trimStart();
  return prefixes.some((prefix) => trimmed.startsWith(prefix));
}

/** Build the instruction passed to the PR-iteration workflow. */
export function buildIterationInstruction(trigger: CommentTrigger): string {
  return trigger.instruction || 'Address the latest review feedback on this pull request.';
}
