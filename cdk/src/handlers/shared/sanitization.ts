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

// ---------------------------------------------------------------------------
// Content sanitization for external/untrusted inputs
// ---------------------------------------------------------------------------

/**
 * The opener of an HTML tag whose content should be stripped entirely (tag + inner text):
 * the name and everything up to the next ">".
 */
const DANGEROUS_OPENER = /<(script|style|iframe|object|embed|form|input)[^>]*>/gi;

/** A dangerous opener and everything up to the first closing tag of its name. Sticky: tried at one opener. */
const DANGEROUS_PAIR = /<(script|style|iframe|object|embed|form|input)[^>]*>[\s\S]*?<\/\1>/iy;

/** Remaining HTML tags — strip tag but preserve inner text. */
const HTML_TAGS = /<\/?[a-z][^>]*>/gi;

/** Instruction-like prefixes at the start of a line (case-insensitive). */
const INSTRUCTION_PREFIXES = /^(SYSTEM|ASSISTANT|Human)\s*:/gim;

/** Phrases commonly used in prompt injection attempts (case-insensitive). */
const INJECTION_PHRASES = /(?:ignore previous instructions|disregard (?:above|previous|all)|new instructions\s*:)/gi;

/** ASCII control characters except tab (0x09), LF (0x0A), CR (0x0D). */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

/** Unicode bidirectional formatting characters and misplaced BOM. */
const BIDI_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const MISPLACED_BOM = /(?!^)\uFEFF/g;

/**
 * How many passes stripUntilStable makes over one text. Ordinary text is stable after two
 * (the second finds nothing); only tags nested as fragments, so that each pass completes
 * the next one, need more.
 */
const MAX_STRIP_PASSES = 20;

/**
 * What stands for the part of a text that stripUntilStable gives up; the steps after the
 * tag stripping leave it as it is. The same in agent/src/sanitization.py.
 */
const NESTED_TAGS_MARKER = '[SANITIZED_NESTED_TAGS]';

/**
 * One pass over the dangerous tags of `text`: every opener goes, with everything up to the
 * first closing tag of its name when one follows, and alone when none does. That is one
 * global replace of "DANGEROUS_PAIR, or else DANGEROUS_OPENER", in time proportional to the
 * length: a search for a closing tag that fails has read to the end of the text and would
 * fail again for every later opener of the same name, so it is made once per name.
 */
function stripDangerousTags(text: string): string {
  const unclosed = new Set<string>();
  const kept: string[] = [];
  let from = 0;
  DANGEROUS_OPENER.lastIndex = 0;
  for (let opener = DANGEROUS_OPENER.exec(text); opener; opener = DANGEROUS_OPENER.exec(text)) {
    const name = opener[1].toLowerCase();
    let end = DANGEROUS_OPENER.lastIndex;
    if (!unclosed.has(name)) {
      DANGEROUS_PAIR.lastIndex = opener.index;
      if (DANGEROUS_PAIR.test(text)) {
        end = DANGEROUS_PAIR.lastIndex;
      } else {
        unclosed.add(name);
      }
    }
    kept.push(text.slice(from, opener.index));
    from = end;
    DANGEROUS_OPENER.lastIndex = end;
  }
  kept.push(text.slice(from));
  return kept.join('');
}

/**
 * Apply a tag-stripping pass repeatedly until the string stops changing.
 *
 * A single pass can be bypassed by nesting fragments
 * (e.g. "<scrip<script></script>t>" reassembles after inner tag removal).
 *
 * The work is proportional to the length of the text:
 * - A pass sees the text up to its last ">" only. Every tag ends with a ">", so nothing
 *   behind the last one is a tag, and a pattern would read that rest once per "<" in it.
 * - The passes are limited. A text that the last of MAX_STRIP_PASSES still changes is
 *   given up: a tag that only a later pass completes would otherwise stay in it. Every
 *   tag starts at a "<", so what stands before the first "<" that is left can change no
 *   more: that part is kept and NESTED_TAGS_MARKER stands for the rest; a text with no
 *   "<" left is complete. A "<" that starts no tag is no exception: it can start one
 *   after a removal, as the first of "<<b>a>" does.
 */
function stripUntilStable(s: string, strip: (text: string) => string): string {
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const end = s.lastIndexOf('>') + 1;
    const head = s.slice(0, end);
    const stripped = strip(head);
    if (stripped === head) return s;
    s = stripped + s.slice(end);
  }
  const first = s.indexOf('<');
  return first < 0 ? s : s.slice(0, first) + NESTED_TAGS_MARKER;
}

/**
 * Sanitize external content before it enters the agent's context.
 *
 * Neutralizes rather than blocks — suspicious patterns are replaced with
 * bracketed markers so content is still visible to the LLM (for legitimate
 * discussion of prompts/instructions) but structurally defanged.
 *
 * The exception is a text whose tags are not gone after MAX_STRIP_PASSES passes: it
 * is cut at its first "<" (see stripUntilStable).
 *
 * Applied to: GitHub issue bodies, PR bodies, review comments, memory records.
 * NOT applied to: task IDs, repo names, or other platform-controlled fields.
 */
export function sanitizeExternalContent(text: string): string {
  if (!text) return text || '';

  // Steps 1 and 2 go first: removed last, an invisible character inside a
  // tag, a prefix or a phrase would hide it from steps 3 to 5.

  // 1. Strip control characters (keep tab, LF, CR)
  let sanitized = text.replace(CONTROL_CHARS, '');

  // 2. Strip Unicode bidirectional overrides and misplaced BOM
  sanitized = sanitized.replace(BIDI_CHARS, '');
  sanitized = sanitized.replace(MISPLACED_BOM, '');

  // 3. Strip dangerous HTML tags with their content
  sanitized = stripUntilStable(sanitized, stripDangerousTags);

  // 4. Strip remaining HTML tags (preserve inner text)
  sanitized = stripUntilStable(sanitized, (head) => head.replace(HTML_TAGS, ''));

  // 5. Neutralize embedded instruction patterns
  sanitized = sanitized.replace(INSTRUCTION_PREFIXES, '[SANITIZED_PREFIX] $1:');
  sanitized = sanitized.replace(INJECTION_PHRASES, '[SANITIZED_INSTRUCTION]');

  return sanitized;
}
