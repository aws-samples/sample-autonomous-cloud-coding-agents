import React from 'react';
import { Box, Text } from 'ink';
import type { PanelId } from './TabBar.js';
import { SEPARATOR_WIDTH } from '../data.js';

interface HelpBarProps {
  panel: PanelId;
  hasApproval?: boolean;
  isEditing?: boolean;
  editMode?: 'text' | 'deny-confirm' | null;
  inDetail?: boolean;
}

const K: React.FC<{ k: string; label: string; color?: string }> = ({ k, label, color }) => (
  <><Text bold color={color ?? 'gray'}>[{k}]</Text><Text dimColor>{label}  </Text></>
);

const HelpBar: React.FC<HelpBarProps> = ({ panel, hasApproval, isEditing, editMode, inDetail }) => {
  const sep = <Text dimColor>{'─'.repeat(SEPARATOR_WIDTH)}</Text>;

  if (isEditing) {
    return (
      <Box flexDirection="column">
        {sep}
        <Box paddingX={1}>
          {editMode === 'deny-confirm' ? (
            <><K k="y" label=" deny" color="red" /><K k="n" label=" cancel" /><K k="Esc" label=" cancel" /></>
          ) : (
            <><K k="Enter" label=" confirm" /><K k="Esc" label=" cancel" /></>
          )}
        </Box>
      </Box>
    );
  }

  const panelHelp: Record<PanelId, React.ReactNode> = {
    tasks: <><K k="Enter" label=" watch" /><K k="↑↓" label=" navigate" /></>,
    watch: <>
      {hasApproval && <><K k="a" label="pprove" color="green" /><K k="d" label="eny" color="red" /></>}
      <K k="n" label="udge" /><K k="↑↓" label=" scroll" /><K k="Esc" label=" back" />
    </>,
    approvals: inDetail ? (
      <><K k="a" label="pprove" color="green" /><K k="d" label="eny" color="red" /><K k="Esc" label=" back" /></>
    ) : (
      <><K k="Enter" label=" detail" /><K k="a" label="pprove" color="green" /><K k="d" label="eny" color="red" /><K k="↑↓" label=" navigate" /></>
    ),
    policies: <><K k="Enter" label=" view" /><K k="Esc" label=" close" /><K k="↑↓" label=" navigate" /></>,
    submit: <><K k="↑↓" label=" navigate" /><K k="Space" label=" toggle" /><K k="Enter" label=" edit/submit" /></>,
  };

  return (
    <Box flexDirection="column">
      {sep}
      <Box paddingX={1} justifyContent="space-between">
        <Box>
          {panelHelp[panel]}
        </Box>
        <Box>
          <Text dimColor>
            1:Tasks  2:Watch  3:Approvals  4:Policies  5:New Task  Tab:next  q:quit
          </Text>
        </Box>
      </Box>
    </Box>
  );
};

export default HelpBar;
