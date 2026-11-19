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
import Header from '@cloudscape-design/components/header';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Toggle from '@cloudscape-design/components/toggle';
import { useMemo, useState } from 'react';
import type { TaskEvent } from '../../../core/api/types';
import { QueryError } from '../../../core/components/QueryError';
import { eventTypeLabel, summarizeEvent } from '../../../core/util/events';
import { formatRelativeTime, formatTimestamp } from '../../../core/util/format';
import { buildTurns } from '../../../core/util/turns';
import { MAX_TASK_EVENTS, useTaskEvents } from '../hooks';
import { TurnList } from './TurnList';

/** Per-tool-call noise; hidden by default so milestones and blockers stand out. */
const VERBOSE_EVENT_TYPES = new Set(['agent_tool_call', 'agent_tool_result', 'agent_turn', 'agent_cost_update']);

type View = 'turns' | 'events';

/** The full record: turn by turn, or every raw event. */
export function EventTimeline({ taskId, live, repo = null, trace = false }: {
  taskId: string;
  live: boolean;
  repo?: string | null;
  trace?: boolean;
}) {
  const query = useTaskEvents(taskId, live);
  const [view, setView] = useState<View>('turns');
  const [verbose, setVerbose] = useState(false);
  const events = useMemo(() => query.data?.events ?? [], [query.data]);
  const turns = useMemo(() => buildTurns(events), [events]);
  const items = useMemo(
    () => [...events].reverse().filter((e) => verbose || !VERBOSE_EVENT_TYPES.has(e.event_type)),
    [events, verbose],
  );

  if (query.isError) return <QueryError error={query.error} what="task events" />;

  const switcher = (
    <SegmentedControl
      selectedId={view}
      label="View"
      onChange={({ detail }) => setView(detail.selectedId as View)}
      options={[{ id: 'turns', text: 'By turn' }, { id: 'events', text: 'Every event' }]}
    />
  );
  const capped = query.data?.truncated
    ? <Box variant="small" color="text-status-inactive">{`Showing the first ${MAX_TASK_EVENTS.toLocaleString()} events.`}</Box>
    : null;

  if (view === 'turns') {
    return (
      <SpaceBetween size="s">
        {switcher}
        {capped}
        {query.isPending ? <Box color="text-status-inactive">Loading…</Box> : <TurnList turns={turns} repo={repo} trace={trace} />}
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="s">
      {switcher}
      {capped}
      <Table<TaskEvent>
        variant="embedded"
        loading={query.isPending}
        loadingText="Loading events"
        items={items}
        trackBy="event_id"
        header={
          <Header
            description="Newest first."
            actions={<Toggle checked={verbose} onChange={({ detail }) => setVerbose(detail.checked)}>Show everything</Toggle>}
          >
            Timeline
          </Header>
        }
        columnDefinitions={[
          {
            id: 'time',
            header: 'When',
            cell: (e) => <span title={formatTimestamp(e.timestamp)}>{formatRelativeTime(e.timestamp)}</span>,
          },
          { id: 'type', header: 'Event', cell: (e) => eventTypeLabel(e.event_type) },
          { id: 'summary', header: 'Details', cell: (e) => summarizeEvent(e) || '-' },
        ]}
        empty={<Box textAlign="center" color="inherit">No events yet.</Box>}
      />
    </SpaceBetween>
  );
}
