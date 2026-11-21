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

import Box from '@cloudscape-design/components/box';
import type { CSSProperties, ReactNode } from 'react';
import { Explain, type Explanation } from './Explain';

const COLUMN_GAP = 40;
const MIN_COLUMN_WIDTH = 220;

/**
 * Tiles side by side in `columns` columns, fewer where the page is narrow. The tiles of
 * a row share its three lines (labels, numbers, notes), so the numbers stay level when
 * one label wraps and the next does not.
 */
export function TileGrid({ columns, children }: { columns: number; children: ReactNode }) {
  // A track is never narrower than its share of `columns` columns, so auto-fill stops at that many;
  // capping it at 100% lets a single column be narrower than the minimum where the page is.
  const column = `max(${MIN_COLUMN_WIDTH}px, (100% - ${(columns - 1) * COLUMN_GAP}px) / ${columns})`;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${column}), 1fr))`, gap: `20px ${COLUMN_GAP}px` }}>
      {children}
    </div>
  );
}

/** The three lines of a tile. In a {@link TileGrid} they are the lines of its row; anywhere else they stack. */
const LINES: CSSProperties = { display: 'grid', gridTemplateRows: 'subgrid', gridRow: 'span 3', rowGap: 0 };

/** A label with the "i" that explains it. The label's last word keeps the icon beside it, so the icon never wraps onto a line of its own. */
export function TileLabel({ label, icon }: { label: string; icon: ReactNode }) {
  const lastWord = label.lastIndexOf(' ') + 1;
  return (
    <Box variant="awsui-key-label">
      {label.slice(0, lastWord)}<span style={{ whiteSpace: 'nowrap' }}>{label.slice(lastWord)} {icon}</span>
    </Box>
  );
}

/**
 * One headline number under its label, with room below for what it rests on.
 * The group is named "<label>: <value>", so a screen reader gets the pair in one
 * stop and hears "loading" or "no data" where the screen shows a dash. The whole
 * tile is the hover target of its explanation, and the "i" stands beside the label.
 */
export function Tile({ label, value, loading = false, explanation, children }: {
  label: string;
  /** The formatted number; null when there is nothing to compute it from. */
  value: string | null;
  loading?: boolean;
  explanation: Explanation;
  children?: ReactNode;
}) {
  const [shown, spoken] = loading ? ['-', 'loading'] : value === null ? ['-', 'no data'] : [value, value];
  return (
    <Explain role="group" aria-label={`${label}: ${spoken}`} style={LINES} title={label} explanation={explanation}>
      {(icon) => (
        <>
          <TileLabel label={label} icon={icon} />
          <Box variant="awsui-value-large">{shown}</Box>
          <div>{children}</div>
        </>
      )}
    </Explain>
  );
}
