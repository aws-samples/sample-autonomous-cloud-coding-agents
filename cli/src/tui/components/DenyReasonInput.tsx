/**
 * Text input for the deny reason. Caps at `DENY_REASON_MAX_LENGTH`
 * (the same limit the server enforces server-side). Returns the
 * trimmed reason on Enter, or empty string on Enter with no input.
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import figures from 'figures';
import { DENY_REASON_MAX_LENGTH } from '../../types.js';

interface DenyReasonInputProps {
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

const DenyReasonInput: React.FC<DenyReasonInputProps> = ({ onConfirm, onCancel }) => {
  const [text, setText] = useState('');

  useInput(useCallback((input, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return) { onConfirm(text.trim()); return; }
    if (key.backspace || key.delete) { setText(p => p.slice(0, -1)); return; }
    if (input && !key.ctrl && !key.meta) {
      // Silently cap at the server limit — pasted walls of text
      // get truncated instead of triggering a scary error.
      const next = text + input;
      setText(next.length > DENY_REASON_MAX_LENGTH ? next.slice(0, DENY_REASON_MAX_LENGTH) : next);
    }
  }, [text, onConfirm, onCancel]));

  const near = text.length >= DENY_REASON_MAX_LENGTH - 100;

  return (
    <Box borderStyle="round" borderColor="red" paddingX={1} flexDirection="column" marginTop={1}>
      <Text color="red" bold>{figures.cross} Deny — optional reason (Enter to send, Esc cancel)</Text>
      <Text dimColor>Reason is sanitized + truncated server-side; blank is accepted.</Text>
      <Box>
        <Text dimColor>{figures.pointer} </Text>
        {text ? <Text>{text}</Text> : <Text dimColor>(empty — agent gets denial with no note)</Text>}
        <Text color="red">|</Text>
      </Box>
      <Text dimColor={!near} color={near ? 'yellow' : undefined}>
        {text.length}/{DENY_REASON_MAX_LENGTH}
      </Text>
    </Box>
  );
};

export default DenyReasonInput;
