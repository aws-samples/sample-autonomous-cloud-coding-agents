import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import figures from 'figures';
import type { TaskSummary } from '../data.js';
import { TRUNC_DESCRIPTION, TRUNC_REPO } from '../data.js';
import { STATUS_COLOR, STATUS_ICON, STATUS_LABEL, timeAgo, trunc } from '../constants.js';

interface TaskListProps {
  tasks: TaskSummary[];
  onSelectTask: (taskId: string) => void;
  active: boolean;
}

const TaskList: React.FC<TaskListProps> = ({ tasks, onSelectTask, active }) => {
  const [cursor, setCursor] = useState(0);

  // Clamp cursor if tasks change
  const safeCursor = Math.min(cursor, Math.max(0, tasks.length - 1));

  useInput(useCallback((input, key) => {
    if (!active || tasks.length === 0) return;
    if (key.upArrow) setCursor(c => Math.max(0, c - 1));
    if (key.downArrow) setCursor(c => Math.min(tasks.length - 1, c + 1));
    if (key.return) onSelectTask(tasks[safeCursor].task_id);
  }, [active, tasks, safeCursor, onSelectTask]));

  if (tasks.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>Tasks</Text>
        <Text> </Text>
        <Text dimColor>No tasks yet. Press <Text bold>5</Text> to submit one.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>Tasks</Text>
        <Text dimColor>  {tasks.length} total, {tasks.filter(t => t.status === 'RUNNING').length} running</Text>
      </Box>
      <Box>
        <Text dimColor>{'  '}</Text>
        <Text dimColor bold>{'ID'.padEnd(8)}</Text>
        <Text dimColor>{'  '}</Text>
        <Text dimColor bold>{'STATUS'.padEnd(20)}</Text>
        <Text dimColor bold>{'REPO'.padEnd(26)}</Text>
        <Text dimColor bold>{'STEP'.padEnd(8)}</Text>
        <Text dimColor bold>{'AGE'.padEnd(8)}</Text>
        <Text dimColor bold>DESCRIPTION</Text>
      </Box>
      {tasks.map((t, i) => {
        const sel = i === safeCursor && active;
        const sc = STATUS_COLOR[t.status] ?? 'white';
        const si = STATUS_ICON[t.status] ?? '?';
        const sl = STATUS_LABEL[t.status] ?? t.status;

        return (
          <Box key={t.task_id}>
            <Text color={sel ? 'cyan' : undefined}>{sel ? figures.pointer + ' ' : '  '}</Text>
            <Text color="blue" underline>{'..'+t.task_id.slice(-4)}</Text>
            <Text>{'    '}</Text>
            <Text color={sc} bold={sel}>{`${si} ${sl}`.padEnd(20)}</Text>
            <Text>{trunc(t.repo, TRUNC_REPO).padEnd(26)}</Text>
            <Text>{`${t.turn}/~${t.max_turns ?? '?'}`.padEnd(8)}</Text>
            <Text dimColor>{timeAgo(t.created_at).padEnd(8)}</Text>
            <Text dimColor={!sel}>{trunc(t.task_description, TRUNC_DESCRIPTION)}</Text>
          </Box>
        );
      })}
    </Box>
  );
};

export default TaskList;
