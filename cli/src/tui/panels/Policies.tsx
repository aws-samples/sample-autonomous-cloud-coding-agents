import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import figures from 'figures';
import { getPolicies, type CedarPolicy } from '../data.js';
import { TIER_LABEL, TIER_COLOR, SEVERITY_COLOR, SEVERITY_LABEL, trunc } from '../constants.js';

interface PoliciesProps { active: boolean; }

const Policies: React.FC<PoliciesProps> = ({ active }) => {
  const [cursor, setCursor] = useState(0);
  const [showDetail, setShowDetail] = useState(false);

  const policies = useMemo(() => getPolicies(), []);
  const denyPolicies = useMemo(() => policies.filter(p => p.tier === 'hard-deny'), [policies]);
  const gatePolicies = useMemo(() => policies.filter(p => p.tier === 'hard-gate'), [policies]);
  const allOrdered = useMemo(() => [...denyPolicies, ...gatePolicies], [denyPolicies, gatePolicies]);

  useInput(useCallback((input, key) => {
    if (!active) return;
    if (key.upArrow) { setCursor(c => Math.max(0, c - 1)); }
    if (key.downArrow) { setCursor(c => Math.min(allOrdered.length - 1, c + 1)); }
    if (key.return) setShowDetail(d => !d);
    if (key.escape) setShowDetail(false);
  }, [active]));

  const selected = allOrdered[cursor];
  let idx = 0;

  const renderPolicy = (p: CedarPolicy) => {
    const i = idx++;
    const sel = i === cursor && active;
    const tierColor = TIER_COLOR[p.tier];
    const tierIcon = p.tier === 'hard-deny' ? figures.cross : figures.warning;
    const sev = (p.severity ?? '').toUpperCase();

    return (
      <Box key={p.rule_id}>
        <Text color={sel ? 'cyan' : undefined}>{sel ? figures.pointer + ' ' : '  '}</Text>
        <Text color={tierColor}>{tierIcon} </Text>
        <Text color="blue" underline>{p.rule_id.padEnd(22)}</Text>
        {sev ? (
          <Text color={SEVERITY_COLOR[sev]} bold>{(SEVERITY_LABEL[sev] ?? sev).padEnd(14)}</Text>
        ) : (
          <Text>{''.padEnd(14)}</Text>
        )}
        <Text>{trunc(p.description, 40)}</Text>
        {sel && !showDetail && <Text dimColor>  Enter to view</Text>}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>Safety Policies</Text>
        <Text dimColor>  {policies.length} rules  |  powered by Cedar</Text>
      </Box>

      <Box>
        <Text color="red" bold>{figures.cross} {TIER_LABEL['hard-deny']}</Text>
        <Text dimColor> — always prevented, cannot be overridden</Text>
      </Box>
      {denyPolicies.map(renderPolicy)}
      <Text> </Text>

      <Box>
        <Text color="magenta" bold>{figures.warning} {TIER_LABEL['hard-gate']}</Text>
        <Text dimColor> — agent pauses and asks you first</Text>
      </Box>
      {gatePolicies.map(renderPolicy)}

      {showDetail && selected && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={TIER_COLOR[selected.tier]} paddingX={1}>
          <Box>
            <Text bold>{selected.rule_id}</Text>
            <Text dimColor>  ({TIER_LABEL[selected.tier]})</Text>
          </Box>
          <Box><Text dimColor>Triggers on:  </Text><Text>{selected.action}</Text></Box>
          {selected.condition_summary && (
            <Box><Text dimColor>When:         </Text><Text>{selected.condition_summary}</Text></Box>
          )}
          {selected.severity && (
            <Box>
              <Text dimColor>Risk level:   </Text>
              <Text color={SEVERITY_COLOR[selected.severity.toUpperCase()]}>{SEVERITY_LABEL[selected.severity.toUpperCase()] ?? selected.severity}</Text>
            </Box>
          )}
          {selected.approval_timeout_s && (
            <Box><Text dimColor>Timeout:      </Text><Text>{selected.approval_timeout_s}s — auto-denied if no response</Text></Box>
          )}
          {selected.tier === 'hard-gate' && (
            <Box><Text dimColor>Skip with:    </Text><Text color="cyan">--pre-approve rule:{selected.rule_id}</Text></Box>
          )}
          <Text> </Text>
          <Text bold dimColor>Cedar source:</Text>
          {selected.cedar_source.split('\n').map((line, li) => (
            <Text key={li} color="yellow">  {line}</Text>
          ))}
        </Box>
      )}
    </Box>
  );
};

export default Policies;
