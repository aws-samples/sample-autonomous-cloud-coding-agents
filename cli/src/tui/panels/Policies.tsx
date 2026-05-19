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
import { Box, Text, useInput } from 'ink';
import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { TIER_LABEL, TIER_COLOR, SEVERITY_COLOR, SEVERITY_LABEL, trunc } from '../constants.js';
import { type PolicyRuleView } from '../data.js';
import { useData } from '../hooks/useData.js';

interface PoliciesProps { active: boolean }

const Policies: React.FC<PoliciesProps> = ({ active }) => {
  const { snapshot, loadPolicies, source } = useData();
  const [cursor, setCursor] = useState(0);
  const [showDetail, setShowDetail] = useState(false);
  const [repoCursor, setRepoCursor] = useState(0);
  /** `null` = repo-picker step; string = viewing that repo's policies. */
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);

  const repos = snapshot.repos;

  // Mock source returns identical policies for any repo, so we can
  // auto-select the first repo when mounted. Live mode waits for the
  // user to pick, so the UI surfaces rule hierarchy per-repo (the API
  // returns repo-specific bundles).
  useEffect(() => {
    if (source.label === 'mock' && repos.length > 0 && selectedRepo === null) {
      setSelectedRepo(repos[0].repo);
    }
  }, [source.label, repos, selectedRepo]);

  // Whenever the selected repo changes, ask the provider to fetch it
  // (idempotent — the provider caches by repo_id).
  useEffect(() => {
    if (selectedRepo) {
      void loadPolicies(selectedRepo);
    }
  }, [selectedRepo, loadPolicies]);

  const policies = selectedRepo
    ? snapshot.policiesByRepo.get(selectedRepo) ?? { hard: [], soft: [] }
    : { hard: [], soft: [] };
  const { hard: hardPolicies, soft: softPolicies } = policies;
  const allOrdered = useMemo(
    () => [...hardPolicies, ...softPolicies],
    [hardPolicies, softPolicies],
  );
  const total = allOrdered.length;

  useInput(useCallback((input, key) => {
    if (!active) return;

    // Repo-picker step
    if (selectedRepo === null) {
      if (repos.length === 0) return;
      if (key.upArrow) { setRepoCursor(c => Math.max(0, c - 1)); return; }
      if (key.downArrow) { setRepoCursor(c => Math.min(repos.length - 1, c + 1)); return; }
      if (key.return || input === ' ') {
        setSelectedRepo(repos[repoCursor].repo);
        return;
      }
      return;
    }

    // Policies list step
    if (key.upArrow) { setCursor(c => Math.max(0, c - 1)); }
    if (key.downArrow) { setCursor(c => Math.min(allOrdered.length - 1, c + 1)); }
    if (key.return) setShowDetail(d => !d);
    if (key.escape) {
      if (showDetail) { setShowDetail(false); return; }
      // Esc from list → back to repo picker (only useful in live mode
      // where there can be multiple repos).
      if (source.label === 'live') {
        setSelectedRepo(null);
        setCursor(0);
      }
    }
  }, [active, selectedRepo, repos, repoCursor, allOrdered.length, showDetail, source.label]));

  // Repo-picker view
  if (selectedRepo === null) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold>Safety Policies</Text>
          <Text dimColor>  pick a repo to see its Cedar rules</Text>
        </Box>
        {repos.length === 0 ? (
          <Text dimColor>No repos discovered yet. Submit a task first, or wait for the next refresh.</Text>
        ) : (
          repos.map((r, i) => {
            const focused = i === repoCursor;
            return (
              <Box key={r.repo}>
                <Text color={focused ? 'cyan' : undefined}>{focused ? figures.pointer + ' ' : '  '}</Text>
                <Text color={focused ? 'cyan' : undefined} bold={focused}>{r.repo}</Text>
                <Text dimColor>  ({r.default_branch})</Text>
              </Box>
            );
          })
        )}
      </Box>
    );
  }

  const selected = allOrdered[cursor];
  let idx = 0;

  const renderPolicy = (p: PolicyRuleView) => {
    const i = idx++;
    const sel = i === cursor && active;
    const tierColor = TIER_COLOR[p.tier];
    const tierIcon = p.tier === 'hard' ? figures.cross : figures.warning;
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
        <Text>{trunc(p.summary, 40)}</Text>
        {sel && !showDetail && <Text dimColor>  Enter to view</Text>}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>Safety Policies</Text>
        <Text dimColor>  {total} rules for </Text>
        <Text color="cyan">{selectedRepo}</Text>
        <Text dimColor>  |  powered by Cedar</Text>
      </Box>

      <Box>
        <Text color="red" bold>{figures.cross} {TIER_LABEL.hard}</Text>
        <Text dimColor> — always prevented, cannot be overridden</Text>
      </Box>
      {hardPolicies.length === 0 ? (
        <Text dimColor>  (none)</Text>
      ) : hardPolicies.map(renderPolicy)}
      <Text> </Text>

      <Box>
        <Text color="magenta" bold>{figures.warning} {TIER_LABEL.soft}</Text>
        <Text dimColor> — agent pauses and asks you first</Text>
      </Box>
      {softPolicies.length === 0 ? (
        <Text dimColor>  (none)</Text>
      ) : softPolicies.map(renderPolicy)}

      {showDetail && selected && (
        <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={TIER_COLOR[selected.tier]} paddingX={1}>
          <Box>
            <Text bold>{selected.rule_id}</Text>
            <Text dimColor>  ({TIER_LABEL[selected.tier]})</Text>
          </Box>
          {selected.action && (
            <Box><Text dimColor>Triggers on:  </Text><Text>{selected.action}</Text></Box>
          )}
          {selected.condition_summary && (
            <Box><Text dimColor>When:         </Text><Text>{selected.condition_summary}</Text></Box>
          )}
          {selected.summary && !selected.condition_summary && (
            <Box><Text dimColor>Summary:      </Text><Text>{selected.summary}</Text></Box>
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
          {selected.tier === 'soft' && (
            <Box><Text dimColor>Skip with:    </Text><Text color="cyan">--pre-approve rule:{selected.rule_id}</Text></Box>
          )}
          {selected.cedar_source && (
            <>
              <Text> </Text>
              <Text bold dimColor>Cedar source:</Text>
              {selected.cedar_source.split('\n').map((line, li) => (
                <Text key={li} color="yellow">  {line}</Text>
              ))}
            </>
          )}
          {!selected.cedar_source && (
            <>
              <Text> </Text>
              <Text dimColor italic>(Raw Cedar source not exposed by the API — see deployed policies in S3.)</Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
};

export default Policies;
