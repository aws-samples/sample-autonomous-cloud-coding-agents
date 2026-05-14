/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

/**
 * Helpers for ink-testing-library based panel tests.
 *
 * `flush()` waits for ink's 20 ms escape-flush timer and then drains
 * microtasks — enough time for keypress → React state → rendered
 * frame to propagate.
 */

export async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 30));
  await new Promise((r) => setImmediate(r));
}

/** Write a key sequence then flush. Avoids boilerplate in tests. */
export async function press(
  stdin: { write: (s: string) => void },
  sequence: string,
): Promise<void> {
  stdin.write(sequence);
  await flush();
}

export const KEY_UP = '\u001B[A';
export const KEY_DOWN = '\u001B[B';
export const KEY_LEFT = '\u001B[D';
export const KEY_RIGHT = '\u001B[C';
export const KEY_ENTER = '\r';
export const KEY_ESC = '\u001B\u001B';
