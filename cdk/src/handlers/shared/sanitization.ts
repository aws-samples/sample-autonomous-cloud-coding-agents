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

/** HTML tags whose content should be stripped entirely (tag + inner text). */
const DANGEROUS_TAGS = /(<(script|style|iframe|object|embed|form|input)[^>]*>[\s\S]*?<\/\2>|<(script|style|iframe|object|embed|form|input)[^>]*\/?>)/gi;

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
 * Apply a regex replacement repeatedly until the string stops changing.
 *
 * A single pass can be bypassed by nesting fragments
 * (e.g. "<scrip<script></script>t>" reassembles after inner tag removal).
 */
function stripUntilStable(s: string, pattern: RegExp): string {
  let prev;
  do {
    prev = s;
    s = s.replace(pattern, '');
  } while (s !== prev);
  return s;
}

/**
 * Sanitize external content before it enters the agent's context.
 *
 * Neutralizes rather than blocks — suspicious patterns are replaced with
 * bracketed markers so content is still visible to the LLM (for legitimate
 * discussion of prompts/instructions) but structurally defanged.
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
  sanitized = stripUntilStable(sanitized, DANGEROUS_TAGS);

  // 4. Strip remaining HTML tags (preserve inner text)
  sanitized = stripUntilStable(sanitized, HTML_TAGS);

  // 5. Neutralize embedded instruction patterns
  sanitized = sanitized.replace(INSTRUCTION_PREFIXES, '[SANITIZED_PREFIX] $1:');
  sanitized = sanitized.replace(INJECTION_PHRASES, '[SANITIZED_INSTRUCTION]');

  return sanitized;
}
