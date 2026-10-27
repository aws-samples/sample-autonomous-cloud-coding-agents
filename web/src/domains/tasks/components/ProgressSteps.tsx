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

/** Queued → Setting up → Working → Checking → Pull request, with the current step highlighted. */
export function ProgressSteps({ states }: { states: readonly StepState[] }) {
  return (
    <ol aria-label="Progress" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px', listStyle: 'none', margin: 0, padding: 0 }}>
      {PROGRESS_STEPS.map((label, i) => {
        const state = states[i];
        return (
          <li key={label} aria-current={state === 'current' ? 'step' : undefined} aria-label={`${label}: ${STATE_LABEL[state]}`}>
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
