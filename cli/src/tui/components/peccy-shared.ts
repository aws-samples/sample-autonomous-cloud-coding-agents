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
 * Shared Peccy rendering logic — used by both PeccyIcon and PeccyMini.
 */
import { Box, Text } from 'ink';
import React from 'react';

export const O = '#E8942A';
export const W = '#FFFFFF';
export const K = '#222222';
export const _ = null;

export type Pixel = string | null;
export type PupilPos = 'left' | 'center' | 'right' | 'down';

// ~51s cycle: mostly idle, occasional glances every ~8s
export const SEQUENCE: PupilPos[] = [
  // idle
  'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center',
  // glance right
  'right', 'right', 'right', 'center',
  // idle
  'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center',
  // glance left
  'left', 'left', 'left', 'center',
  // idle
  'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center',
  // look down
  'down', 'down', 'down', 'down', 'down', 'center',
  // idle
  'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center',
  // quick double-take
  'right', 'right', 'right', 'center', 'center', 'left', 'left', 'left',
  // idle
  'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center', 'center',
  // look down
  'down', 'down', 'down', 'down', 'down', 'center',
];

export const ANIM_INTERVAL = 400;

/** Convert a pixel grid to half-block rendered Ink elements. */
export function renderPixelGrid(grid: Pixel[][]): React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const topRow = grid[y] ?? [];
    const botRow = grid[y + 1] ?? [];
    const maxCols = Math.max(topRow.length, botRow.length);
    const cells: React.ReactNode[] = [];
    for (let x = 0; x < maxCols; x++) {
      const top = topRow[x] ?? null;
      const bot = botRow[x] ?? null;
      const key = `${y}-${x}`;
      if (top && bot && top === bot) cells.push(React.createElement(Text, { key, color: top }, '█'));
      else if (top && !bot) cells.push(React.createElement(Text, { key, color: top }, '▀'));
      else if (!top && bot) cells.push(React.createElement(Text, { key, color: bot }, '▄'));
      else if (top && bot) cells.push(React.createElement(Text, { key, color: top, backgroundColor: bot }, '▀'));
      else cells.push(React.createElement(Text, { key }, ' '));
    }
    lines.push(React.createElement(Box, { key: `line-${y}` }, ...cells));
  }
  return lines;
}
