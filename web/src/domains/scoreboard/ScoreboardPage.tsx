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

import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useSearchParams } from 'react-router';
import type { Flagged, Scoreboard, ScoreboardPeriod, ScoreboardRange } from '../../core/api/types';
import { seriesColor, useDarkMode } from '../../core/components/chart-palette';
import { Explain } from '../../core/components/Explain';
import { QueryError } from '../../core/components/QueryError';
import { RouterLink } from '../../core/components/RouterLink';
import { Swatch } from '../../core/components/Swatch';
import { Tile, TileGrid } from '../../core/components/Tile';
import { choiceOptions, parseChoice } from '../../core/util/choices';
import { formatCount, shortId, taskHref } from '../../core/util/format';
import {
  contextLine,
  nothingFinished,
  outcomeParts,
  outcomeRows,
  previousLine,
  SCOREBOARD_RANGES,
  SECTIONS,
  truncationNotice,
  type OutcomeRow,
  type SectionSpec,
  type TileSpec,
} from '../../core/util/scoreboard';
import { NewTaskButton } from '../tasks/components/NewTaskButton';
import { useScoreboard } from './hooks';

function TaskLinks({ flagged }: { flagged: Flagged }) {
  const unnamed = flagged.count - flagged.task_ids.length;
  return (
    <Box color="text-body-secondary">
      {flagged.task_ids.map((id, i) => (
        <span key={id}>
          {i > 0 && ', '}
          <RouterLink href={taskHref(id)} variant="primary" ariaLabel={`Task ${shortId(id)}`}>{shortId(id)}</RouterLink>
        </span>
      ))}
      {unnamed > 0 && ` and ${formatCount(unnamed)} more`}
    </Box>
  );
}

function ScoreTile({ tile, board }: { tile: TileSpec; board: Scoreboard | undefined }) {
  const detail = board && tile.detail?.(board.current, board);
  const tasks = board && tile.tasks?.(board.current, board);
  const before = board && previousLine(tile, board);
  return (
    <Tile label={tile.label} loading={!board} value={board ? tile.value(board.current, board) : null} explanation={tile.explanation}>
      {tasks && <TaskLinks flagged={tasks} />}
      {detail && <Box color="text-body-secondary">{detail}</Box>}
      {before && <Box variant="small" color="text-body-secondary">{before}</Box>}
    </Tile>
  );
}

const COLUMNS = 3;

function Section({ section, board }: { section: SectionSpec; board: Scoreboard | undefined }) {
  return (
    <Container
      header={<Header variant="h2" description={section.description}>{section.title}</Header>}
      footer={<Box variant="small" color="text-body-secondary">{section.notMeasured}</Box>}
    >
      <TileGrid columns={COLUMNS}>
        {section.tiles.map((tile) => <ScoreTile key={tile.label} tile={tile} board={board} />)}
      </TileGrid>
    </Container>
  );
}

const BAR_HEIGHT = 8;
const BAR_REACH = 8;
const PART_MIN_WIDTH = 24;

function OutcomeBar({ period, dark }: { period: ScoreboardPeriod; dark: boolean }) {
  const parts = outcomeParts(period).filter((part) => part.count > 0);
  const round = (end: boolean) => (end ? BAR_HEIGHT / 2 : 0);
  return (
    <div role="group" aria-label="Tasks finished, by how they ended" style={{ display: 'flex', gap: 2, margin: `-${BAR_REACH}px 0` }}>
      {parts.map((part, i) => {
        const [start, end] = [round(i === 0), round(i === parts.length - 1)];
        return (
          <Explain
            key={part.label}
            title={part.label}
            summary={part.summary}
            explanation={part.explanation}
            role="img"
            aria-label={`${part.label}: ${part.summary}`}
            tabIndex={0}
            style={{ flex: `${part.count} 0 0px`, minWidth: PART_MIN_WIDTH, padding: `${BAR_REACH}px 0` }}
          >
            <div style={{ height: BAR_HEIGHT, background: seriesColor(part.slot, dark), borderRadius: `${start}px ${end}px ${end}px ${start}px` }} />
          </Explain>
        );
      })}
    </div>
  );
}

function Outcomes({ period }: { period: ScoreboardPeriod | undefined }) {
  const dark = useDarkMode();
  return (
    <Container header={<Header variant="h2" description="Activity is a diagnostic, not a score.">Tasks finished</Header>}>
      <div style={{ maxWidth: 700 }}>
        <SpaceBetween size="m">
          {period && period.finished > 0 && <OutcomeBar period={period} dark={dark} />}
          <Table<OutcomeRow>
            variant="embedded"
            wrapLines
            ariaLabels={{ tableLabel: 'Tasks finished by outcome' }}
            loading={!period}
            loadingText="Loading the scoreboard"
            items={period ? outcomeRows(period) : []}
            trackBy="outcome"
            columnDefinitions={[
              {
                id: 'outcome',
                header: 'Outcome',
                isRowHeader: true,
                cell: (row) => <span style={{ display: 'flex', alignItems: 'baseline' }}><Swatch color={seriesColor(row.slot, dark)} />{row.label}</span>,
              },
              { id: 'tasks', header: 'Tasks', cell: (row) => formatCount(row.count) },
              { id: 'share', header: 'Share', cell: (row) => row.share ?? '-' },
            ]}
          />
        </SpaceBetween>
      </div>
    </Container>
  );
}

function ScoreboardBody({ board, stale }: { board: Scoreboard | undefined; stale: boolean }) {
  const nothing = board?.current.finished === 0 && !board.open_over_7d?.count;
  return (
    <>
      <div role="status">
        {!board || stale ? (
          <Box variant="p" margin={{ bottom: 'l' }}><StatusIndicator type="loading">Loading the scoreboard</StatusIndicator></Box>
        ) : !nothing && (
          <Box variant="p" margin={{ bottom: 'l' }}>{contextLine(board)}</Box>
        )}
      </div>
      <div aria-busy={stale} style={{ opacity: stale ? 0.5 : 1 }}>
        {nothing ? (
          <Container>
            <Box textAlign="center" color="inherit">
              <Box variant="p" color="inherit">{nothingFinished(board)}</Box>
              <NewTaskButton />
            </Box>
          </Container>
        ) : (
          <SpaceBetween size="l">
            {board?.truncated && <Alert type="warning" header="These numbers cover part of the range">{truncationNotice(board)}</Alert>}
            {SECTIONS.map((section) => <Section key={section.title} section={section} board={board} />)}
            <Outcomes period={board?.current} />
            <Box variant="small" color="text-status-inactive">
              {'These numbers cover your own tasks. A period is 7 or 30 times 24 hours back from now and its spend is that of the tasks that'
                + ' write code, while the Costs page adds every task over whole UTC days, so the same range can show a different spend there.'
                + ' Numbers for every user are on the CloudWatch dashboard, in the "Factory scoreboard" row.'}
            </Box>
          </SpaceBetween>
        )}
      </div>
    </>
  );
}

export function ScoreboardPage() {
  const [params, setParams] = useSearchParams();
  const range = parseChoice<ScoreboardRange>(params.get('range'), SCOREBOARD_RANGES, '30d');
  const query = useScoreboard(range);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description="How the work you hand to agents turns into merged pull requests: speed, quality, leverage and trust. Your own tasks, up to the merge."
          actions={
            <SegmentedControl
              label="Time range"
              selectedId={range}
              options={choiceOptions(SCOREBOARD_RANGES)}
              onChange={({ detail }) => setParams({ range: detail.selectedId }, { replace: true })}
            />
          }
        >
          Scoreboard
        </Header>
      }
    >
      {query.isError
        ? <QueryError error={query.error} what="the scoreboard" />
        : <ScoreboardBody board={query.data} stale={query.isPlaceholderData} />}
    </ContentLayout>
  );
}
