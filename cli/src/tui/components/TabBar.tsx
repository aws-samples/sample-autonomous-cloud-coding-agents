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
import { useApprovals } from '../context.js';
import { SEPARATOR_WIDTH, type TaskRowView } from '../data.js';
import PeccyMini from './PeccyMini.js';

export type PanelId = 'tasks' | 'watch' | 'approvals' | 'policies' | 'submit';

interface TabBarProps {
  active: PanelId;
  tasks: TaskRowView[];
}

const TabBar: React.FC<TabBarProps> = ({ active, tasks }) => {
  const { approvals } = useApprovals();

  const activeTasks = tasks.filter(t =>
    ['RUNNING', 'AWAITING_APPROVAL', 'HYDRATING'].includes(t.status),
  );

  const tabs: { id: PanelId; label: string; badge?: number; badgeColor?: string }[] = [
    { id: 'tasks', label: 'Tasks', badge: activeTasks.length || undefined },
    { id: 'watch', label: 'Watch' },
    { id: 'approvals', label: 'Approvals', badge: approvals.length || undefined, badgeColor: 'magenta' },
    { id: 'policies', label: 'Policies' },
    { id: 'submit', label: 'New Task' },
  ];

  // Context-aware status badges
  const statusParts: React.ReactNode[] = [];
  if (activeTasks.length > 0) {
    statusParts.push(<Text key="active" color="green">{figures.bullet} {activeTasks.length} active</Text>);
  }
  if (approvals.length > 0) {
    statusParts.push(<Text key="approvals" color="magenta">{figures.warning} {approvals.length} pending</Text>);
  }
  if (statusParts.length === 0) {
    statusParts.push(<Text key="idle" dimColor>{figures.bullet} idle</Text>);
  }

  const statusLine = (
    <Box>
      {statusParts.map((part, i) => (
        <React.Fragment key={i}>
          {i > 0 && <Text dimColor>  </Text>}
          {part}
        </React.Fragment>
      ))}
    </Box>
  );

  const tabStrip = (
    <Box>
      {tabs.map((tab, i) => {
        const isActive = tab.id === active;
        const badge = tab.badge ? ` ${tab.badge}` : '';
        return (
          <React.Fragment key={tab.id}>
            {i > 0 && <Text dimColor> │ </Text>}
            {isActive ? (
              <Text bold color="cyan">{tab.label}{badge}</Text>
            ) : (
              <Box>
                <Text dimColor>{tab.label}</Text>
                {tab.badge && <Text color={tab.badgeColor ?? 'cyan'} bold>{badge}</Text>}
              </Box>
            )}
          </React.Fragment>
        );
      })}
    </Box>
  );

  // Always use PeccyMini (full Peccy is only on splash screen)
  return (
    <Box flexDirection="column">
      <Box>
        <Box marginRight={1}>
          <PeccyMini />
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Box>
            <Text bold color="white">Autonomous Cloud Coding Agents</Text>
            <Text>  </Text>
            {statusLine}
          </Box>
          <Box>
            {tabStrip}
          </Box>
        </Box>
      </Box>
      <Text dimColor>{'─'.repeat(SEPARATOR_WIDTH)}</Text>
    </Box>
  );
};

export default TabBar;
