import React from 'react';
import { Box, Text } from 'ink';
import figures from 'figures';
import { SEVERITY_COLOR, SEVERITY_LABEL, trunc, fmtDuration } from '../constants.js';
import { TRUNC_TOOL_INPUT, TRUNC_REASON, TRUNC_DESCRIPTION } from '../data.js';
import type { TaskEvent } from '../data.js';

interface ApprovalCardProps {
  event: TaskEvent;
  taskDescription?: string;
  repo?: string;
  timeoutRemaining?: number;
}

const ApprovalCard: React.FC<ApprovalCardProps> = ({ event, taskDescription, repo, timeoutRemaining }) => {
  const m = event.metadata;
  const sev = ((m.severity ?? 'MEDIUM') as string).toUpperCase();
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
        <Text bold>{m.tool_name}</Text>
        <Text> {figures.arrowRight} </Text>
        <Text>{trunc(m.input_preview ?? '', TRUNC_TOOL_INPUT)}</Text>
      </Box>
      <Box>
        <Text dimColor>Why:       </Text>
        <Text>{trunc(m.reason ?? '', TRUNC_REASON)}</Text>
      </Box>
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
