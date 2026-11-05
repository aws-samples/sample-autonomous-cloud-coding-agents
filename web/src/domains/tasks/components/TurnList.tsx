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
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { describeStep } from '../../../core/util/activity';
import { formatTimestamp } from '../../../core/util/format';
import type { Turn } from '../../../core/util/turns';
import { StepDetail } from './StepDetail';

const SUMMARY_LENGTH = 100;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SUMMARY_LENGTH ? `${flat.slice(0, SUMMARY_LENGTH - 1)}…` : flat;
}

/** "Ran a command", or "Read src/a.ts and 2 more" when the turn used several tools. */
function summary(turn: Turn, repo: string | null): string {
  const first = turn.tools[0];
  if (!first) return turn.said ? `Said: ${oneLine(turn.said)}` : 'Thought it over';
  const action = describeStep(first, repo).text;
  return turn.tools.length > 1 ? `${action} and ${turn.tools.length - 1} more` : action;
}

/**
 * Every turn in order. Each opens to what the agent said and every tool it
 * called, with the call's input and output.
 */
export function TurnList({ turns, repo, trace }: { turns: readonly Turn[]; repo: string | null; trace: boolean }) {
  if (turns.length === 0) return <Box color="text-status-inactive">No turns yet.</Box>;
  return (
    <SpaceBetween size="xxs">
      {turns.map((turn) => (
        <ExpandableSection
          key={turn.number}
          variant="footer"
          headerText={`Turn ${turn.number}: ${summary(turn, repo)}`}
          headerDescription={formatTimestamp(turn.at)}
        >
          <SpaceBetween size="m">
            {turn.said && (
              <div>
                <Box variant="awsui-key-label">It said</Box>
                <Box color="text-body-secondary"><span style={{ whiteSpace: 'pre-wrap' }}>{turn.said}</span></Box>
              </div>
            )}
            {turn.thinking && (
              <div>
                <Box variant="awsui-key-label">Its reasoning</Box>
                <Box color="text-body-secondary"><span style={{ whiteSpace: 'pre-wrap' }}>{turn.thinking}</span></Box>
              </div>
            )}
            {turn.tools.map((step) => <StepDetail key={step.id} step={step} trace={trace} />)}
            {!turn.said && !turn.thinking && turn.tools.length === 0 && (
              <Box color="text-status-inactive">The agent thought privately; the platform does not keep that text.</Box>
            )}
          </SpaceBetween>
        </ExpandableSection>
      ))}
    </SpaceBetween>
  );
}
