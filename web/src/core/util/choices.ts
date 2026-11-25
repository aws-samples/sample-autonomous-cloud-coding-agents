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
 * A choice a page keeps in its URL (`?range=7d`) and offers as a segmented control.
 * The choices are a record of id to label, in the order they are shown.
 */

/** The choice a URL parameter names; `fallback` when it is absent or names none. */
export function parseChoice<T extends string>(value: string | null, labels: Readonly<Record<T, string>>, fallback: T): T {
  // Own keys only: `in` also finds what every object inherits, such as `constructor`.
  return value !== null && Object.hasOwn(labels, value) ? (value as T) : fallback;
}

export function choiceOptions<T extends string>(labels: Readonly<Record<T, string>>) {
  return (Object.keys(labels) as T[]).map((id) => ({ id, text: labels[id] }));
}
