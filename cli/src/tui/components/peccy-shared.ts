/**
 * Shared Peccy rendering logic — used by both PeccyIcon and PeccyMini.
 */
import React from 'react';
import { Box, Text } from 'ink';

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
