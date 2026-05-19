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

import figures from 'figures';
import { Box, Text } from 'ink';
import React from 'react';
import { SEVERITY_COLOR, SEVERITY_LABEL, trunc, fmtDuration } from '../constants.js';
import { TRUNC_TOOL_INPUT, TRUNC_REASON, TRUNC_DESCRIPTION, type TaskEvent } from '../data.js';

interface ApprovalCardProps {
  event: TaskEvent;
  taskDescription?: string;
  repo?: string;
  timeoutRemaining?: number;
}

/** Narrow a `Record<string, unknown>` metadata field to string for
 *  display. Wire `TaskEvent.metadata` is typed `unknown` per value so
 *  the agent side can evolve without breaking the consumer; the TUI
 *  always just wants a string for preview. */
function mstr(m: Record<string, unknown>, key: string, fallback = ''): string {
  const v = m[key];
  return typeof v === 'string' ? v : fallback;
}

function mstrlist(m: Record<string, unknown>, key: string): readonly string[] {
  const v = m[key];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

const ApprovalCard: React.FC<ApprovalCardProps> = ({ event, taskDescription, repo, timeoutRemaining }) => {
  const m = event.metadata;
  const sev = mstr(m, 'severity', 'MEDIUM').toUpperCase();
  const sevColor = SEVERITY_COLOR[sev] ?? 'yellow';
  const sevLabel = SEVERITY_LABEL[sev] ?? sev;
  const timeColor = timeoutRemaining != null
    ? (timeoutRemaining <= 120 ? 'red' : timeoutRemaining <= 300 ? 'yellow' : undefined)
    : undefined;

  return (
    <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1} marginY={1}>
      <Box justifyContent="space-between">
        <Text color="magenta" bold>{figures.warning} Approval needed</Text>
        <Text color={sevColor} bold>{sevLabel}</Text>
      </Box>

      {(repo || taskDescription) && (
        <Text dimColor>Task: {repo ?? ''}{taskDescription ? ` — ${trunc(taskDescription, TRUNC_DESCRIPTION)}` : ''}</Text>
      )}

      <Text> </Text>
      <Box>
        <Text dimColor>Wants to:  </Text>
        <Text bold>{mstr(m, 'tool_name')}</Text>
        <Text> {figures.arrowRight} </Text>
        <Text>{trunc(mstr(m, 'input_preview'), TRUNC_TOOL_INPUT)}</Text>
      </Box>
      <Box>
        <Text dimColor>Why:       </Text>
        <Text>{trunc(mstr(m, 'reason'), TRUNC_REASON)}</Text>
      </Box>
      {mstrlist(m, 'matching_rule_ids').length > 0 && (
        <Box>
          <Text dimColor>Triggered: </Text>
          <Text color="yellow">{mstrlist(m, 'matching_rule_ids').join(', ')}</Text>
        </Box>
      )}
      {timeoutRemaining != null && (
        <Box>
          <Text dimColor>Timeout:   </Text>
          <Text color={timeColor}>{fmtDuration(timeoutRemaining)}</Text>
          {timeoutRemaining <= 120 && <Text color="red"> {figures.warning}</Text>}
        </Box>
      )}
      <Text> </Text>
      <Box>
        <Text color="green" bold>[a]</Text><Text> Approve   </Text>
        <Text color="red" bold>[d]</Text><Text> Deny</Text>
        <Text dimColor>   3 for full detail</Text>
      </Box>
    </Box>
  );
};

export default ApprovalCard;
