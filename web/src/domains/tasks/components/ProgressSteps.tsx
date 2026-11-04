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
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import type { CSSProperties } from 'react';
import { PROGRESS_STEPS, type StepState } from '../../../core/util/progress';

const INDICATOR: Readonly<Record<StepState, StatusIndicatorProps.Type>> = {
  done: 'success',
  current: 'in-progress',
  todo: 'pending',
  stopped: 'error',
  skipped: 'stopped',
};

const STATE_LABEL: Readonly<Record<StepState, string>> = {
  done: 'done',
  current: 'in progress',
  todo: 'not started',
  stopped: 'stopped here',
  skipped: 'skipped',
};

/** Colour of the line leading into a step: travelled, stopped there, or still ahead. */
function connectorStyle(state: StepState): CSSProperties {
  const base: CSSProperties = { flex: '1 1 24px', minWidth: 16, height: 0, margin: '0 10px', borderTopWidth: 2 };
  if (state === 'todo' || state === 'skipped') return { ...base, borderTopStyle: 'dashed', borderTopColor: 'rgba(127, 127, 127, 0.45)' };
  return { ...base, borderTopStyle: 'solid', borderTopColor: state === 'stopped' ? '#d13212' : '#2ea043' };
}

/**
 * Queued → Setting up → Working → Checking → Pull request, joined by a line like a
 * timeline: solid up to the current step, dashed for what is still ahead.
 */
export function ProgressSteps({ states }: { states: readonly StepState[] }) {
  return (
    <ol aria-label="Progress" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', rowGap: 8, listStyle: 'none', margin: 0, padding: 0 }}>
      {PROGRESS_STEPS.map((label, i) => {
        const state = states[i];
        return (
          <li
            key={label}
            aria-current={state === 'current' ? 'step' : undefined}
            aria-label={`${label}: ${STATE_LABEL[state]}`}
            style={{ display: 'flex', alignItems: 'center', flex: i === 0 ? '0 0 auto' : '1 1 auto' }}
          >
            {i > 0 && <span aria-hidden="true" data-testid="progress-connector" data-state={state} style={connectorStyle(state)} />}
            <StatusIndicator type={INDICATOR[state]} colorOverride={state === 'todo' ? 'grey' : undefined}>
              <Box
                variant="span"
                fontWeight={state === 'current' || state === 'stopped' ? 'bold' : 'normal'}
                color={state === 'todo' ? 'text-status-inactive' : 'inherit'}
              >
                {label}
              </Box>
            </StatusIndicator>
          </li>
        );
      })}
    </ol>
  );
}
