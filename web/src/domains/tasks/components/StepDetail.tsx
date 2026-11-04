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

import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import type { CSSProperties } from 'react';
import type { ToolStep } from '../../../core/util/turns';

/** Labels for the arguments people look for; others show their own name. */
const FIELD_LABEL: Readonly<Record<string, string>> = {
  command: 'Command',
  file_path: 'File',
  path: 'Path',
  pattern: 'Pattern',
  old_string: 'Replaced',
  new_string: 'With',
  content: 'Content',
  url: 'URL',
};

/** Arguments the step's own line already says (`description`) or not worth a block. */
const HIDDEN_FIELDS = new Set(['description', 'timeout', 'run_in_background', 'replace_all']);

/** Scrolls long commands and output instead of stretching the page; the tint works in light and dark mode. */
const CODE_BLOCK: CSSProperties = {
  boxSizing: 'border-box',
  width: '100%',
  maxHeight: 320,
  overflow: 'auto',
  padding: '4px 10px',
  borderRadius: 8,
  background: 'rgba(127, 127, 127, 0.12)',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

function Code({ children }: { children: string }) {
  return <div style={CODE_BLOCK}><Box variant="pre" fontSize="body-s">{children}</Box></div>;
}

function CutNote({ trace }: { trace: boolean }) {
  return (
    <Box variant="small" color="text-status-inactive">
      {trace
        ? 'Shortened: the platform keeps the first 4 KB.'
        : 'Shortened: the platform keeps the first 200 characters. Turn on "Keep full details" when starting a task to keep up to 4 KB.'}
    </Box>
  );
}

/** One tool call: what the agent asked for and what came back. */
export function StepDetail({ step, trace }: { step: ToolStep; trace: boolean }) {
  const fields = Object.entries(step.input).filter(([key]) => !HIDDEN_FIELDS.has(key));
  return (
    <SpaceBetween size="xs">
      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
        <Box variant="small" color="text-body-secondary">Turn {step.turn} · {step.tool}</Box>
        {step.isError && <StatusIndicator type="error">Failed</StatusIndicator>}
      </SpaceBetween>
      {fields.length > 0
        ? fields.map(([key, value]) => (
          <div key={key}>
            <Box variant="awsui-key-label">{FIELD_LABEL[key] ?? key}</Box>
            <Code>{value}</Code>
          </div>
        ))
        : step.rawInput && <Code>{step.rawInput}</Code>}
      {step.inputCutOff && <CutNote trace={trace} />}
      <div>
        <Box variant="awsui-key-label">{step.isError ? 'Error' : 'Output'}</Box>
        {step.output === null
          ? <Box color="text-status-inactive">Still running, or no output was recorded.</Box>
          : step.output.trim() === ''
            ? <Box color="text-status-inactive">No output.</Box>
            : <Code>{step.output}</Code>}
      </div>
      {step.outputCutOff && <CutNote trace={trace} />}
    </SpaceBetween>
  );
}
