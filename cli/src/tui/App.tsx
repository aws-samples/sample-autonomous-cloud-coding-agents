/**
 * bgagent TUI — Tier 3 Full-screen tabbed application
 *
 * Splash: full-size Peccy for 2.5s, then switches to mini Peccy on all tabs.
 */
import React, { useState, useCallback, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import PeccyIcon from './components/PeccyIcon.js';
import TabBar, { type PanelId } from './components/TabBar.js';
import HelpBar from './components/HelpBar.js';
import { useEditing, useApprovals } from './context.js';
import { getTasks, getTask } from './data.js';
import TaskList from './panels/TaskList.js';
import Watch from './panels/Watch.js';
import Approvals from './panels/Approvals.js';
import Policies from './panels/Policies.js';
import Submit from './panels/Submit.js';

const PANELS: PanelId[] = ['tasks', 'watch', 'approvals', 'policies', 'submit'];
const SPLASH_DURATION = 2500; // ms

const App: React.FC = () => {
  const { exit } = useApp();
  const { isEditing, editMode } = useEditing();
  const { approvals } = useApprovals();
  const [splash, setSplash] = useState(true);
  const [ready, setReady] = useState(false);
  const [panel, setPanel] = useState<PanelId>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [approvalsInDetail, setApprovalsInDetail] = useState(false);
  const tasks = getTasks();

  // Splash timer — any keypress also dismisses it
  useEffect(() => {
    const timer = globalThis.setTimeout(() => setSplash(false), SPLASH_DURATION);
    return () => clearTimeout(timer);
  }, []);

  // Clear screen when transitioning from splash to main to prevent flicker
  useEffect(() => {
    if (!splash && !ready) {
      process.stdout.write('\x1b[2J\x1b[H'); // clear screen + move cursor home
      setReady(true);
    }
  }, [splash, ready]);

  const selectedTask = selectedTaskId ? getTask(selectedTaskId) : undefined;

  const hasApproval = panel === 'watch' && selectedTask &&
    approvals.some(a => a.task_id === selectedTask.task_id);

  useInput(useCallback((input, key) => {
    // Any key dismisses splash
    if (splash) { setSplash(false); return; }

    if (isEditing) return;
    if (input === 'q' && panel !== 'submit') { exit(); return; }

    const panelMap: Record<string, PanelId> = {
      '1': 'tasks', '2': 'watch', '3': 'approvals', '4': 'policies', '5': 'submit',
    };
    if (panelMap[input] && panel !== panelMap[input]) { setPanel(panelMap[input]); return; }
    if (key.tab && !key.shift) { setPanel(PANELS[(PANELS.indexOf(panel) + 1) % PANELS.length]); return; }
    if (key.tab && key.shift) { setPanel(PANELS[(PANELS.indexOf(panel) - 1 + PANELS.length) % PANELS.length]); return; }
  }, [panel, isEditing, splash, exit]));

  const handleSelectTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setPanel('watch');
  }, []);

  const handleBack = useCallback(() => setPanel('tasks'), []);

  const handleSubmitted = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setPanel('watch');
  }, []);

  const handleDetailChange = useCallback((inDetail: boolean) => setApprovalsInDetail(inDetail), []);

  // ── Splash screen ──
  if (splash) {
    return (
      <Box flexDirection="column" alignItems="center" justifyContent="center" minHeight={20}>
        <PeccyIcon />
        <Text> </Text>
        <Text bold color="white">Autonomous Cloud Coding Agents</Text>
        <Text> </Text>
        <Text dimColor>Press any key to continue...</Text>
      </Box>
    );
  }

  // Brief clear frame between splash and main
  if (!ready) return <Box />;

  // ── Main TUI ──
  return (
    <Box flexDirection="column">
      <TabBar active={panel} tasks={tasks} />
      <Box flexDirection="column" minHeight={15}>
        {panel === 'tasks' && <TaskList tasks={tasks} onSelectTask={handleSelectTask} active />}
        {panel === 'watch' && selectedTask && <Watch task={selectedTask} active onBack={handleBack} />}
        {panel === 'watch' && !selectedTask && (
          <Box flexDirection="column" paddingX={1}>
            <Text bold>Watch</Text>
            <Text> </Text>
            <Text dimColor>No task selected. Press <Text bold>1</Text> to go to Tasks, then <Text bold>Enter</Text> to watch one.</Text>
          </Box>
        )}
        {panel === 'approvals' && <Approvals active onDetailChange={handleDetailChange} />}
        {panel === 'policies' && <Policies active />}
        {panel === 'submit' && <Submit active onSubmitted={handleSubmitted} />}
      </Box>
      <HelpBar panel={panel} hasApproval={hasApproval} isEditing={isEditing} editMode={editMode} inDetail={approvalsInDetail} />
    </Box>
  );
};

export default App;
