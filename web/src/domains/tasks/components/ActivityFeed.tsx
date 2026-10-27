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
import Icon, { type IconProps } from '@cloudscape-design/components/icon';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useEffect, useRef } from 'react';
import type { ActivityKind, ActivityLine } from '../../../core/util/activity';

const ICON: Readonly<Record<ActivityKind, IconProps.Name>> = {
  action: 'caret-right-filled',
  said: 'contact',
  step: 'flag',
  message: 'envelope',
  problem: 'status-warning',
};

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** What the agent did, oldest at the top, in plain words. Follows new lines as they arrive. */
export function ActivityFeed({ lines, loading, live }: { lines: readonly ActivityLine[]; loading: boolean; live: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  const count = lines.length;
  useEffect(() => {
    if (live && count > 0) end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count, live]);

  if (loading) return <Box color="text-status-inactive">Loading…</Box>;
  if (count === 0) return <Box color="text-status-inactive">Nothing yet. Updates appear here as the agent works.</Box>;

  return (
    <div style={{ maxHeight: 480, overflowY: 'auto' }}>
      <ul aria-label="Activity" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {lines.map((line) => (
          <li key={line.id} style={{ padding: '4px 0' }}>
            <SpaceBetween direction="horizontal" size="xs" alignItems="start">
              <Box variant="small" color="text-status-inactive"><span style={{ display: 'inline-block', minWidth: 44 }}>{time(line.at)}</span></Box>
              <Icon name={ICON[line.kind]} variant={line.kind === 'problem' ? 'warning' : 'subtle'} size="small" />
              <div>
                <Box
                  variant="span"
                  fontWeight={line.kind === 'step' ? 'bold' : 'normal'}
                  color={line.kind === 'said' ? 'text-body-secondary' : 'inherit'}
                >
                  {line.kind === 'said' ? <i>“{line.text}”</i> : line.text}
                </Box>
                {line.detail && (
                  <Box variant="code" fontSize="body-s" color="text-body-secondary" display="block">{line.detail}</Box>
                )}
              </div>
            </SpaceBetween>
          </li>
        ))}
      </ul>
      <div ref={end} />
    </div>
  );
}
