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

import { hasHelpLabel, DEFAULT_LABEL_FILTER } from '../../../src/handlers/shared/trigger-label';

describe('DEFAULT_LABEL_FILTER', () => {
  test('is the documented default a project inherits without a label_filter', () => {
    // Load-bearing: the project-mapping table treats an absent label_filter as
    // this value, and the rollup renders it in operator-facing copy. Changing it
    // silently stops every project that never set one explicitly.
    expect(DEFAULT_LABEL_FILTER).toBe('bgagent');
  });
});

describe('hasHelpLabel', () => {
  test('detects the base:help label, case-insensitive', () => {
    expect(hasHelpLabel(['bgagent:help'])).toBe(true);
    expect(hasHelpLabel(['BGAgent:Help'])).toBe(true);
    expect(hasHelpLabel(['something', 'bgagent:help', 'other'])).toBe(true);
  });

  test('respects a custom label filter', () => {
    expect(hasHelpLabel(['ship:help'], 'ship')).toBe(true);
    expect(hasHelpLabel(['bgagent:help'], 'ship')).toBe(false);
  });

  test('is false for the trigger label and for lookalikes', () => {
    // The help label must not fire on the plain trigger (that would explain the
    // labels instead of doing the work), nor on a name that merely contains
    // "help".
    expect(hasHelpLabel(['bgagent'])).toBe(false);
    expect(hasHelpLabel(['helpful', 'bghelp'])).toBe(false);
    expect(hasHelpLabel([])).toBe(false);
    expect(hasHelpLabel([undefined, null])).toBe(false);
  });
});
