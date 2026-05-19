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

/**
 * Reusable ApprovalScope picker used by Approvals + Watch (for the
 * approve action) and Submit (for the initial_approvals seed).
 *
 * Shows the full 9-variant ApprovalScope vocabulary defined in
 * `cli/src/types.ts`:
 *
 *   Short forms:   this_call, tool_type_session, tool_group_session,
 *                  all_session
 *   Prefixed:      tool_type:<name>, tool_group:<name>,
 *                  bash_pattern:<glob>, write_path:<glob>,
 *                  rule:<id>
 *
 * The prefixed forms open a text-input step where the user types the
 * operand. Validation mirrors the CLI's `submit` command (server-side
 * parser also rejects invalid forms, but we fail fast locally).
 *
 * `all_session` is the "nuclear option": the picker requires an
 * extra y/n confirmation before returning it (matches the CLI's
 * `--yes` guard in `commands/approve.ts`).
 */

import figures from 'figures';
import { Box, Text, useInput } from 'ink';
import React, { useState, useCallback } from 'react';
import type { ApprovalScope } from '../../types.js';

interface ScopeOption {
  readonly key: string;
  readonly label: string;
  /** When set, the scope is a prefix and the picker asks the user
   *  for the operand before returning. */
  readonly prefix?: 'tool_type' | 'tool_group' | 'bash_pattern' | 'write_path' | 'rule';
  /** Raw short-form scope (used when `prefix` is unset). */
  readonly shortForm?: 'this_call' | 'tool_type_session' | 'tool_group_session' | 'all_session';
}

const OPTIONS: readonly ScopeOption[] = [
  { key: 'this_call', label: 'Just this one call', shortForm: 'this_call' },
  { key: 'tool_type_session', label: 'Any call of this tool type, for this session', shortForm: 'tool_type_session' },
  { key: 'tool_group_session', label: 'Any call in this tool group, for this session', shortForm: 'tool_group_session' },
  { key: 'tool_type', label: 'tool_type:<Name>   (e.g. Bash, Edit)', prefix: 'tool_type' },
  { key: 'tool_group', label: 'tool_group:<name>  (e.g. file_write)', prefix: 'tool_group' },
  { key: 'bash_pattern', label: 'bash_pattern:<glob>  (e.g. npm *)', prefix: 'bash_pattern' },
  { key: 'write_path', label: 'write_path:<glob>  (e.g. src/**)', prefix: 'write_path' },
  { key: 'rule', label: 'rule:<rule_id>  (skip this Cedar rule)', prefix: 'rule' },
  { key: 'all_session', label: `${figures.warning} Full autonomy — approves everything`, shortForm: 'all_session' },
];

interface ScopePickerProps {
  onConfirm: (scope: ApprovalScope) => void;
  onCancel: () => void;
  /** When true, the picker is rendered inline (as an overlay); used
   *  by Approvals detail view. Pass false to render without extra
   *  border so it nests inside the calling panel's layout. */
  bordered?: boolean;
  heading?: string;
}

type Step =
  | { kind: 'picking' }
  | { kind: 'operand'; optionKey: string; prefix: NonNullable<ScopeOption['prefix']>; value: string }
  | { kind: 'confirm-all-session' };

const ScopePicker: React.FC<ScopePickerProps> = ({ onConfirm, onCancel, bordered = true, heading = 'Pick a scope' }) => {
  const [cursor, setCursor] = useState(0);
  const [step, setStep] = useState<Step>({ kind: 'picking' });

  useInput(useCallback((input, key) => {
    if (step.kind === 'picking') {
      if (key.escape) { onCancel(); return; }
      if (key.upArrow) { setCursor(c => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setCursor(c => Math.min(OPTIONS.length - 1, c + 1)); return; }
      if (key.return || input === ' ') {
        const opt = OPTIONS[cursor];
        if (opt.shortForm === 'all_session') {
          setStep({ kind: 'confirm-all-session' });
          return;
        }
        if (opt.prefix) {
          setStep({ kind: 'operand', optionKey: opt.key, prefix: opt.prefix, value: '' });
          return;
        }
        if (opt.shortForm) {
          onConfirm(opt.shortForm);
          return;
        }
      }
      return;
    }

    if (step.kind === 'operand') {
      if (key.escape) { setStep({ kind: 'picking' }); return; }
      if (key.return) {
        const v = step.value.trim();
        if (v.length === 0) return;
        // Mirror server-side cap. `INITIAL_APPROVALS_MAX_ENTRY_LENGTH`
        // is re-exported from `cli/src/types.ts`, but the composed
        // scope is `prefix:operand` — check total length.
        const scope = `${step.prefix}:${v}` as ApprovalScope;
        if (scope.length > 128) return;
        onConfirm(scope);
        return;
      }
      if (key.backspace || key.delete) {
        setStep({ ...step, value: step.value.slice(0, -1) });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setStep({ ...step, value: step.value + input });
        return;
      }
      return;
    }

    if (step.kind === 'confirm-all-session') {
      if (input === 'y' || input === 'Y') {
        onConfirm('all_session');
        return;
      }
      if (key.escape || input === 'n' || input === 'N') {
        setStep({ kind: 'picking' });
        return;
      }
    }
  }, [step, cursor, onConfirm, onCancel]));

  const body =
    step.kind === 'picking' ? (
      <Box flexDirection="column">
        <Text bold>{heading}</Text>
        <Text dimColor>↑↓ pick, Enter confirm, Esc cancel</Text>
        <Text> </Text>
        {OPTIONS.map((opt, i) => {
          const focused = i === cursor;
          const isDanger = opt.shortForm === 'all_session';
          return (
            <Box key={opt.key}>
              <Text color={focused ? 'cyan' : undefined}>{focused ? figures.pointer + ' ' : '  '}</Text>
              <Text bold={focused} color={isDanger ? 'yellow' : undefined}>{opt.label}</Text>
            </Box>
          );
        })}
      </Box>
    ) : step.kind === 'operand' ? (
      <Box flexDirection="column">
        <Text bold>Enter operand for {step.prefix}:</Text>
        <Box>
          <Text dimColor>{step.prefix}:</Text>
          <Text>{step.value}</Text>
          <Text color="cyan">|</Text>
        </Box>
        <Text dimColor>Enter to confirm, Esc to go back</Text>
        {step.value.length > 0 && (
          <Text dimColor>
            Length: {step.prefix.length + 1 + step.value.length}/128
          </Text>
        )}
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text color="yellow" bold>{figures.warning} all_session grants the agent blanket approval</Text>
        <Text>for every subsequent gate in this task. Are you sure?</Text>
        <Box>
          <Text color="red" bold>[y]</Text><Text> Confirm  </Text>
          <Text bold>[n]</Text><Text> Cancel</Text>
        </Box>
      </Box>
    );

  if (!bordered) return body;
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" marginTop={1}>
      {body}
    </Box>
  );
};

export default ScopePicker;
