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
 * Bracketed-paste integration for Ink.
 *
 * What this does:
 *   1. Enables bracketed paste mode on TUI mount by writing
 *      `\x1b[?2004h` to stdout. Disables it on unmount + on
 *      common termination signals so the user's shell doesn't
 *      inherit a wedged terminal.
 *   2. Attaches a raw stdin listener that watches for the
 *      paste-start sequence `\x1b[200~`. When seen, fires the
 *      `onPaste` callback. The body between start and end
 *      (`\x1b[201~`) is drained and discarded — for our use
 *      case (image paste), the body is irrelevant: we read
 *      the OS clipboard directly via pngpaste/xclip/etc.
 *   3. Continues to forward every other byte to whatever input
 *      consumer Ink already wired up. We do this passively
 *      (a non-consuming `data` listener) so `useInput` keeps
 *      working unchanged.
 *
 * Why side-channel instead of `useInput`:
 *   Ink's input parser flushes a lone `\x1b` after a 20 ms delay
 *   to disambiguate "Esc pressed" from "Esc began an arrow key".
 *   That delay can fragment a paste-start marker depending on
 *   how the terminal flushes its TTY buffer. By reading raw
 *   stdin in addition to `useInput`, we always see paste sequences
 *   in one piece — and `useInput` handles the rest of the input
 *   grammar correctly.
 *
 * Cmd+V on macOS:
 *   Cmd+V triggers the terminal's built-in paste action. With
 *   bracketed paste enabled, that action emits the start marker
 *   on stdin *before* the clipboard's text representation. Our
 *   handler fires at the start marker, reads the OS clipboard
 *   directly (which still holds the image bytes since the
 *   single-owner clipboard hasn't moved on yet), and attaches the
 *   image. The bracketed-paste body is then drained without being
 *   forwarded to the prompt text input. Net effect: the user's
 *   muscle-memory Cmd+V "just works" for screenshots.
 */

import { useEffect, useRef } from 'react';

const PASTE_ENABLE = '\x1b[?2004h';
const PASTE_DISABLE = '\x1b[?2004l';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

export interface BracketedPasteOptions {
  /** Fires when a paste sequence begins. Synchronous so the
   *  handler can spawn its clipboard reader before the user's
   *  next clipboard mutation could overwrite it. */
  readonly onPaste: () => void;
  /** When false, the hook is a no-op. Lets the caller gate the
   *  feature on platform support / config. */
  readonly enabled?: boolean;
}

/** Strip start markers from a chunk and report whether at least one
 *  was seen. Exported for tests. */
export function processBracketedChunk(
  buf: Buffer,
  inPaste: boolean,
): { sawStart: boolean; sawEnd: boolean; remainingInPaste: boolean; passthrough: Buffer } {
  let sawStart = false;
  let sawEnd = false;
  const out: Buffer[] = [];
  const startBytes = Buffer.from(PASTE_START, 'utf8');
  const endBytes = Buffer.from(PASTE_END, 'utf8');
  let i = 0;
  let pasting = inPaste;
  while (i < buf.length) {
    if (!pasting && buf.length - i >= startBytes.length && buf.subarray(i, i + startBytes.length).equals(startBytes)) {
      sawStart = true;
      pasting = true;
      i += startBytes.length;
      continue;
    }
    if (pasting && buf.length - i >= endBytes.length && buf.subarray(i, i + endBytes.length).equals(endBytes)) {
      sawEnd = true;
      pasting = false;
      i += endBytes.length;
      continue;
    }
    if (!pasting) {
      // Forward bytes outside paste regions unchanged. (We don't
      // actually use the passthrough buffer in production — Ink's
      // own listener already handles them — but we surface it for
      // tests so they can verify we don't corrupt non-paste input.)
      out.push(buf.subarray(i, i + 1));
    }
    // Inside a paste body: drain silently. The image already came
    // from the OS clipboard via the onPaste callback.
    i += 1;
  }
  return { sawStart, sawEnd, remainingInPaste: pasting, passthrough: Buffer.concat(out) };
}

export function useBracketedPaste(opts: BracketedPasteOptions): void {
  const onPasteRef = useRef(opts.onPaste);
  onPasteRef.current = opts.onPaste;

  useEffect(() => {
    if (opts.enabled === false) return;

    process.stdout.write(PASTE_ENABLE);

    let inPaste = false;
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      const { sawStart, remainingInPaste } = processBracketedChunk(buf, inPaste);
      inPaste = remainingInPaste;
      if (sawStart) {
        // Fire-and-forget — the handler's own state machine
        // decides what to do (probably spawn clipboard reader).
        try {
          onPasteRef.current();
        } catch {
          // Swallow — never let a paste-handler crash kill the TUI.
        }
      }
    };

    process.stdin.on('data', onData);

    const restore = () => process.stdout.write(PASTE_DISABLE);
    const onSignal = () => { restore(); };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    process.on('exit', restore);

    return () => {
      process.stdin.off('data', onData);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('exit', restore);
      restore();
    };
  }, [opts.enabled]);
}
