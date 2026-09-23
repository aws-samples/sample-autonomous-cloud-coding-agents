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

// SPDX-License-Identifier: MIT-0

import { evaluateAgentHeartbeat } from '../../../src/handlers/shared/agent-heartbeat';

test.each([
  [undefined, undefined, 1_000_000, undefined],
  [NaN, undefined, 1_000_000, undefined],
  [0, undefined, 360_000, undefined],
  [0, undefined, 360_001, 'missing'],
  [0, -200_000, 120_000, undefined],
  [0, -200_000, 120_001, 'stale'],
  [0, 120_000, 360_000, undefined],
  [0, 120_000, 360_001, 'stale'],
  [0, 400_000, 360_001, undefined],
] as const)('heartbeat boundary: start=%s heartbeat=%s now=%s yields %s', (start, heartbeat, now, expected) => {
  expect(evaluateAgentHeartbeat(start, heartbeat, now)).toBe(expected);
});
