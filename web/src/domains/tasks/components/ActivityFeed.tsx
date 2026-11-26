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
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ActivityKind, ActivityLine } from '../../../core/util/activity';
import { StepDetail } from './StepDetail';

const ICON: Readonly<Record<ActivityKind, IconProps.Name>> = {
  action: 'caret-right-filled',
  said: 'contact',
  step: 'flag',
  message: 'envelope',
  problem: 'status-warning',
};

const DAY = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit' });

function clock(iso: string): { time: string; day: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { time: '', day: '' };
  return { time: TIME.format(date), day: DAY.format(date) };
}

const FOLLOW_SLACK_PX = 120;

const TOGGLE: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  margin: 0,
  font: 'inherit',
  color: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
};

function LineText({ line, open = false }: { line: ActivityLine; open?: boolean }) {
  return (
    <>
      <Box
        variant="span"
        fontWeight={line.kind === 'step' ? 'bold' : 'normal'}
        color={line.kind === 'said' ? 'text-body-secondary' : 'inherit'}
      >
        {line.kind === 'said' ? <i>“{line.text}”</i> : line.text}
      </Box>
      {line.detail && !open && (
        <Box variant="code" fontSize="body-s" color="text-body-secondary" display="block">{line.detail}</Box>
      )}
    </>
  );
}

function FeedLine({ line, time, newDay, trace }: { line: ActivityLine; time: string; newDay: string | false; trace: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <li style={{ padding: '4px 0' }}>
      {newDay && <Box variant="small" color="text-status-inactive" padding={{ top: 'xs' }}>{newDay}</Box>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <Box variant="small" color="text-status-inactive"><span style={{ display: 'inline-block', minWidth: 44 }}>{time}</span></Box>
        <Icon name={line.step ? (open ? 'caret-down-filled' : 'caret-right-filled') : ICON[line.kind]} variant={line.kind === 'problem' ? 'warning' : 'subtle'} size="small" />
        <div style={{ minWidth: 0, flex: 1 }}>
          {line.step
            ? (
              <button type="button" style={TOGGLE} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                <LineText line={line} open={open} />
              </button>
            )
            : <LineText line={line} />}
          {line.step && open && <div style={{ marginTop: 6, maxWidth: 900 }}><StepDetail step={line.step} trace={trace} /></div>}
        </div>
      </div>
    </li>
  );
}

/**
 * What the agent did, oldest at the top, in plain words. Follows new lines as they
 * arrive. Commands and other tool calls open to show what ran and what came back.
 */
export function ActivityFeed({ lines, loading, live, trace = false }: {
  lines: readonly ActivityLine[];
  loading: boolean;
  live: boolean;
  /** The task keeps 4 KB previews, so shortened ones explain that. */
  trace?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const count = lines.length;
  const following = useRef(true);
  const onScroll = () => {
    const el = box.current;
    if (el) following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
  };
  useEffect(() => {
    if (live && count > 0 && following.current) end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [count, live]);

  if (loading) return <Box color="text-status-inactive">Loading…</Box>;
  if (count === 0) return <Box color="text-status-inactive">Nothing yet. Updates appear here as the agent works.</Box>;

  const clocks = lines.map((line) => clock(line.at));

  return (
    <div ref={box} onScroll={onScroll} style={{ maxHeight: 480, overflowY: 'auto' }}>
      <ul aria-label="Activity" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {lines.map((line, i) => (
          <FeedLine key={line.id} line={line} time={clocks[i].time} newDay={i > 0 && clocks[i].day !== clocks[i - 1].day && clocks[i].day} trace={trace} />
        ))}
      </ul>
      <div ref={end} />
    </div>
  );
}
