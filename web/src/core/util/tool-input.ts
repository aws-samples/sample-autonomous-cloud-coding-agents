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
 * The agent stores each tool call's arguments as a Python dict repr
 * (`{'command': "ls -a", 'description': 'List files'}`), cut to a fixed length
 * with `...` appended. These helpers read it back as best they can.
 */

/** The marker the agent appends when it shortens a preview. */
const CUT_MARKER = '...';
/** Shortest preview the agent shortens: 200 characters plus the marker. */
const SHORTEST_CUT_LENGTH = 200 + CUT_MARKER.length;

export interface ToolInput {
  /** Argument values in order; the one named by `cutOffField` is incomplete. */
  readonly fields: Readonly<Record<string, string>>;
  /** True when the agent shortened the preview, so later arguments are missing. */
  readonly cutOff: boolean;
  /** The argument whose value the cut landed in, if any. */
  readonly cutOffField: string | null;
}

const EMPTY: ToolInput = { fields: {}, cutOff: false, cutOffField: null };

/** True when a stored preview was shortened by the agent. */
export function isCutOff(preview: string): boolean {
  return preview.length >= SHORTEST_CUT_LENGTH && preview.endsWith(CUT_MARKER);
}

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' };

/** Reads a quoted Python string starting after its opening quote. */
function readQuoted(text: string, start: number, quote: string): { value: string; end: number | null } {
  let value = '';
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === quote) return { value, end: i + 1 };
    if (ch !== '\\' || i + 1 >= text.length) {
      value += ch;
      continue;
    }
    const next = text[i + 1];
    const hex = next === 'x' ? 2 : next === 'u' ? 4 : 0;
    const digits = hex ? text.slice(i + 2, i + 2 + hex) : '';
    if (hex && digits.length === hex && /^[0-9a-f]+$/i.test(digits)) {
      value += String.fromCharCode(parseInt(digits, 16));
      i += 1 + hex;
    } else {
      value += ESCAPES[next] ?? `\\${next}`;
      i += 1;
    }
  }
  return { value, end: null };
}

/** Reads an unquoted value (number, `True`, a list…) up to the next top-level comma or brace. */
function readBare(text: string, start: number): { value: string; end: number | null } {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const quoted = readQuoted(text, i + 1, ch);
      if (quoted.end === null) return { value: text.slice(start), end: null };
      i = quoted.end - 1;
    } else if (ch === '[' || ch === '{' || ch === '(') {
      depth += 1;
    } else if ((ch === ']' || ch === '}' || ch === ')') && depth > 0) {
      depth -= 1;
    } else if ((ch === ',' || ch === '}') && depth === 0) {
      return { value: text.slice(start, i).trim(), end: i };
    }
  }
  return { value: text.slice(start).trim(), end: null };
}

/** Parses a tool-input preview into its arguments. Never throws; unknown shapes give no fields. */
export function parseToolInput(preview: string | null | undefined): ToolInput {
  if (!preview) return EMPTY;
  const cutOff = isCutOff(preview);
  const text = cutOff ? preview.slice(0, -CUT_MARKER.length) : preview;
  if (!text.trimStart().startsWith('{')) return { ...EMPTY, cutOff };

  const fields: Record<string, string> = {};
  let i = text.indexOf('{') + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    const quote = text[i];
    if (quote !== "'" && quote !== '"') break;
    const key = readQuoted(text, i + 1, quote);
    if (key.end === null) break;
    i = key.end;
    while (text[i] === ' ') i += 1;
    if (text[i] !== ':') break;
    i += 1;
    while (text[i] === ' ') i += 1;
    const open = text[i];
    const value = open === "'" || open === '"' ? readQuoted(text, i + 1, open) : readBare(text, i);
    fields[key.value] = value.value;
    if (value.end === null) return { fields, cutOff: true, cutOffField: key.value };
    i = value.end;
  }
  return { fields, cutOff, cutOffField: null };
}

/**
 * One argument from a preview. A value the cut landed in is returned only when
 * `partial` is set, since half a description reads worse than none.
 */
export function previewField(preview: string | null, key: string, { partial = false } = {}): string | null {
  const input = parseToolInput(preview);
  const value = input.fields[key];
  if (value === undefined || value.trim() === '') return null;
  if (input.cutOffField === key && !partial) return null;
  return value;
}
