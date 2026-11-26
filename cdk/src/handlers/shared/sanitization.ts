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

const DANGEROUS_OPENER = /<(script|style|iframe|object|embed|form|input)[^>]*>/gi;

const DANGEROUS_PAIR = /<(script|style|iframe|object|embed|form|input)[^>]*>[\s\S]*?<\/\1>/iy;

const HTML_TAGS = /<\/?[a-z][^>]*>/gi;

const INSTRUCTION_PREFIXES = /^(SYSTEM|ASSISTANT|Human)\s*:/gim;

const INJECTION_PHRASES = /(?:ignore previous instructions|disregard (?:above|previous|all)|new instructions\s*:)/gi;

// eslint-disable-next-line no-control-regex -- the sanitizer strips control characters, so its pattern names them
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const BIDI_CHARS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const MISPLACED_BOM = /(?!^)\uFEFF/g;

const MAX_STRIP_PASSES = 20;

const NESTED_TAGS_MARKER = '[SANITIZED_NESTED_TAGS]';

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
 * The HTML_TAGS replace is written out in the loop, not handed in as a function: CodeQL
 * (js/incomplete-multi-character-sanitization) reports a tag-removing replace that it
 * cannot see repeated.
 */
function stripUntilStable(s: string, strip?: (text: string) => string): string {
  let head = s;
  let tail = '';
  for (let pass = 0; pass < MAX_STRIP_PASSES; pass++) {
    const end = head.lastIndexOf('>') + 1;
    tail = head.slice(end) + tail;
    const stripped = strip ? strip(head.slice(0, end)) : head.slice(0, end).replace(HTML_TAGS, '');
    if (stripped.length === end) return stripped + tail;
    head = stripped;
  }
  const rest = head + tail;
  const first = rest.indexOf('<');
  return first < 0 ? rest : rest.slice(0, first) + NESTED_TAGS_MARKER;
}

/**
 * Sanitize external content before it enters the agent's context.
 *
 * Neutralizes rather than blocks — suspicious patterns are replaced with
 * bracketed markers.
 *
 * The exception is a text whose tags are not gone after MAX_STRIP_PASSES passes: it
 * is cut at its first "<".
 */
export function sanitizeExternalContent(text: string): string {
  if (!text) return text || '';

  let sanitized = text.replace(CONTROL_CHARS, '');

  sanitized = sanitized.replace(BIDI_CHARS, '');
  sanitized = sanitized.replace(MISPLACED_BOM, '');

  sanitized = stripUntilStable(sanitized, stripDangerousTags);

  sanitized = stripUntilStable(sanitized);

  sanitized = sanitized.replace(INSTRUCTION_PREFIXES, '[SANITIZED_PREFIX] $1:');
  sanitized = sanitized.replace(INJECTION_PHRASES, '[SANITIZED_INSTRUCTION]');

  return sanitized;
}
