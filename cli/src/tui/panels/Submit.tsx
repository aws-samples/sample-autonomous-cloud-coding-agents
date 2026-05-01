import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import figures from 'figures';
import { useEditing } from '../context.js';
import { getRegisteredRepos } from '../data.js';
import { SCOPE_LABELS } from '../constants.js';

interface SubmitProps {
  active: boolean;
  onSubmitted: (taskId: string) => void;
}

const SCOPES = Object.entries(SCOPE_LABELS).map(([value, label]) => ({ value, label }));

type Field = 'repo' | 'prompt' | 'scopes' | 'submit';
const FIELDS: Field[] = ['repo', 'prompt', 'scopes', 'submit'];

const Submit: React.FC<SubmitProps> = ({ active, onSubmitted }) => {
  const { setEditing } = useEditing();
  const repos = useMemo(() => getRegisteredRepos(), []);
  const [field, setField] = useState<Field>('repo');
  const [repoCursor, setRepoCursor] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [selectedScopes, setSelectedScopes] = useState<Set<string>>(new Set());
  const [scopeCursor, setScopeCursor] = useState(0);
  const [submitted, setSubmitted] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const submitTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  const fieldIdx = FIELDS.indexOf(field);
  const selectedRepo = repos[repoCursor]?.repo ?? '';

  useEffect(() => {
    setEditing(editingText);
    return () => setEditing(false);
  }, [editingText, setEditing]);

  useEffect(() => () => { if (submitTimer.current) clearTimeout(submitTimer.current); }, []);

  useInput(useCallback((input, key) => {
    if (!active || submitted) return;

    // ── Text editing mode (prompt only) ──
    if (editingText) {
      if (key.escape || key.return) { setEditingText(false); return; }
      if (key.backspace || key.delete) { setPrompt(p => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setPrompt(p => p + input); }
      return;
    }

    // ── Repo selector ──
    if (field === 'repo') {
      if (key.upArrow) {
        if (repoCursor > 0) setRepoCursor(c => c - 1);
        // at top of repo list, don't go anywhere (it's the first field)
        return;
      }
      if (key.downArrow) {
        if (repoCursor < repos.length - 1) setRepoCursor(c => c + 1);
        else setField('prompt'); // exit repo list into next field
        return;
      }
      if (input === ' ' || key.return) {
        // repo is selected by cursor position, space/enter confirms and moves on
        setField('prompt');
        return;
      }
      return;
    }

    // ── Scope list ──
    if (field === 'scopes') {
      if (key.upArrow) {
        if (scopeCursor > 0) setScopeCursor(c => c - 1);
        else setField(FIELDS[fieldIdx - 1]);
        return;
      }
      if (key.downArrow) {
        if (scopeCursor < SCOPES.length - 1) setScopeCursor(c => c + 1);
        else setField(FIELDS[fieldIdx + 1]);
        return;
      }
      if (input === ' ' || key.return) {
        const scope = SCOPES[scopeCursor];
        if (scope.value === 'all_session') {
          setSelectedScopes(prev => prev.has('all_session') ? new Set() : new Set(['all_session']));
        } else {
          setSelectedScopes(prev => {
            const n = new Set(prev);
            n.delete('all_session');
            if (n.has(scope.value)) n.delete(scope.value); else n.add(scope.value);
            return n;
          });
        }
        return;
      }
      return;
    }

    // ── General field navigation ──
    if (key.downArrow) {
      const next = Math.min(fieldIdx + 1, FIELDS.length - 1);
      setField(FIELDS[next]);
      if (FIELDS[next] === 'scopes') setScopeCursor(0);
      if (FIELDS[next] === 'repo') setRepoCursor(0);
      return;
    }
    if (key.upArrow) {
      const prev = Math.max(fieldIdx - 1, 0);
      setField(FIELDS[prev]);
      if (FIELDS[prev] === 'scopes') setScopeCursor(SCOPES.length - 1);
      if (FIELDS[prev] === 'repo') setRepoCursor(repos.length - 1);
      return;
    }

    // Prompt text editing
    if (field === 'prompt' && key.return) { setEditingText(true); return; }

    // Submit
    if (field === 'submit' && key.return) {
      if (!selectedRepo || !prompt) return;
      setSubmitted(true);
      const fakeId = '01JBX9NEW' + Math.random().toString(36).slice(2, 8).toUpperCase();
      submitTimer.current = globalThis.setTimeout(() => onSubmitted(fakeId), 500);
      return;
    }
  }, [active, submitted, editingText, field, fieldIdx, repoCursor, repos, scopeCursor, prompt, selectedRepo, onSubmitted]));

  if (submitted) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="green" bold>{figures.tick} Task submitted!</Text>
        <Text dimColor>Repo: {selectedRepo}  |  Switching to Watch…</Text>
      </Box>
    );
  }

  const cur = (f: Field) => field === f && active ? figures.pointer + ' ' : '  ';
  const fc = (f: Field) => field === f && active ? 'cyan' : undefined;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>New Task</Text>
        <Text dimColor>  {figures.arrowUp}/{figures.arrowDown} navigate, Space/Enter to select</Text>
      </Box>

      {/* Repo selector */}
      <Box flexDirection="column">
        <Box>
          <Text color={fc('repo')}>{cur('repo')}</Text>
          <Text dimColor>Repository:    </Text>
          {field !== 'repo' && <Text bold>{selectedRepo}</Text>}
        </Box>
        {field === 'repo' && (
          <Box marginLeft={4} flexDirection="column">
            {repos.map((r, i) => {
              const focused = i === repoCursor;
              return (
                <Box key={r.repo}>
                  <Text color={focused ? 'cyan' : undefined}>{focused ? figures.pointer + ' ' : '  '}</Text>
                  <Text color={focused ? 'cyan' : undefined} bold={focused}>{r.repo}</Text>
                  <Text dimColor>  ({r.default_branch})</Text>
                </Box>
              );
            })}
          </Box>
        )}
      </Box>

      {/* Prompt */}
      <Box>
        <Text color={fc('prompt')}>{cur('prompt')}</Text>
        <Text dimColor>Instructions:  </Text>
        <Text bold={field === 'prompt'}>{prompt || '(empty)'}</Text>
        {field === 'prompt' && editingText && <Text color="cyan">|</Text>}
        {field === 'prompt' && !editingText && !prompt && <Text dimColor>  Enter to type</Text>}
      </Box>

      {/* Scopes */}
      <Box flexDirection="column">
        <Box>
          <Text color={fc('scopes')}>{cur('scopes')}</Text>
          <Text dimColor>Auto-approve:  </Text>
          {field !== 'scopes' && selectedScopes.size === 0 && <Text dimColor>(none — agent asks for everything)</Text>}
          {field !== 'scopes' && selectedScopes.size > 0 && (
            <Text>{[...selectedScopes].map(s => SCOPE_LABELS[s]?.split('(')[0]?.trim() ?? s).join(', ')}</Text>
          )}
        </Box>
        {field === 'scopes' && (
          <Box marginLeft={4} flexDirection="column">
            {SCOPES.map((s, i) => {
              const checked = selectedScopes.has(s.value);
              const focused = i === scopeCursor;
              const isDanger = s.value === 'all_session';
              return (
                <Box key={s.value}>
                  <Text color={focused ? 'cyan' : undefined}>{focused ? figures.pointer + ' ' : '  '}</Text>
                  <Text color={isDanger && checked ? 'red' : undefined}>{checked ? figures.tick : figures.circle} </Text>
                  <Text bold={focused} color={isDanger ? 'yellow' : undefined}>{s.label}</Text>
                </Box>
              );
            })}
            <Text dimColor>  {figures.arrowUp}/{figures.arrowDown} move, Space toggle</Text>
          </Box>
        )}
      </Box>

      <Text> </Text>

      {/* Submit button */}
      <Box>
        <Text color={fc('submit')}>{cur('submit')}</Text>
        <Text bold color={field === 'submit' ? 'green' : 'gray'}>{'[ Submit Task ]'}</Text>
        {field === 'submit' && (!selectedRepo || !prompt) && (
          <Text color="red">  {figures.cross} repository and instructions required</Text>
        )}
      </Box>
    </Box>
  );
};

export default Submit;
