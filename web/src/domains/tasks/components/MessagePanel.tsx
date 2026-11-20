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

import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Textarea, { type TextareaProps } from '@cloudscape-design/components/textarea';
import { forwardRef, useState } from 'react';
import { NUDGE_MAX_MESSAGE_LENGTH, type TaskEvent } from '../../../core/api/types';
import { InfoTip } from '../../../core/components/InfoTip';
import { nudgeIdTail } from '../../../core/util/activity';
import { useSendMessage } from '../hooks';

interface SentMessage {
  readonly nudgeId: string;
  readonly text: string;
  readonly at: string;
}

const storageKey = (taskId: string) => `abca-console-messages:${taskId}`;

/** Messages you sent from this tab; the API has no "list my messages" call, so the console remembers them. */
function loadSent(taskId: string): SentMessage[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(storageKey(taskId)) ?? '[]');
    return Array.isArray(parsed) ? (parsed as SentMessage[]) : [];
  } catch {
    return []; // nosemgrep: ts-silent-success-masking -- display-only memory of sent messages; unreadable storage just shows none
  }
}

/** The agent reports which messages it read in a `nudge_acknowledged` milestone (`ids=…a1b2c3d4`). */
function seenTails(events: readonly TaskEvent[]): string {
  return events
    .filter((e) => e.event_type === 'agent_milestone' && e.metadata?.milestone === 'nudge_acknowledged')
    .map((e) => String(e.metadata.details ?? ''))
    .join(' ');
}

export interface MessagePanelProps {
  readonly taskId: string;
  readonly events: readonly TaskEvent[];
  /** False once the task has finished; the agent can no longer read messages. */
  readonly open: boolean;
}

/**
 * Send the agent a message, and see whether it has read the ones you sent. Sits under
 * the activity it refers to; once the task has finished only earlier messages show.
 */
export const MessagePanel = forwardRef<TextareaProps.Ref, MessagePanelProps>(function MessagePanel({ taskId, events, open }, ref) {
  const send = useSendMessage(taskId);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<SentMessage[]>(() => loadSent(taskId));
  const seen = seenTails(events);
  const tooLong = draft.length > NUDGE_MAX_MESSAGE_LENGTH;

  const submit = () => {
    const text = draft.trim();
    if (!text || tooLong || send.isPending) return;
    send.mutate(text, {
      onSuccess: (res) => {
        const next = [...sent, { nudgeId: res.nudge_id, text, at: res.submitted_at }];
        setSent(next);
        sessionStorage.setItem(storageKey(taskId), JSON.stringify(next));
        setDraft('');
      },
    });
  };

  if (!open && sent.length === 0) return null;

  return (
    <SpaceBetween size="s">
      <SpaceBetween direction="horizontal" size="xxs" alignItems="center">
        <Box variant="h3" padding="n">Message the agent</Box>
        <InfoTip about="Messages">
          Use this to add something you forgot or to change direction. The agent reads your message the next time it
          pauses, usually when it thinks it is done, so it can't stop a step that is already running. "Seen" means it
          has read it.
        </InfoTip>
      </SpaceBetween>
      {sent.map((m) => (
        <div key={m.nudgeId}>
          <Box variant="small" color="text-status-inactive">You</Box>
          <Box>{m.text}</Box>
          {seen.includes(nudgeIdTail(m.nudgeId))
            ? <StatusIndicator type="success">Seen</StatusIndicator>
            : <StatusIndicator type={open ? 'pending' : 'stopped'}>{open ? 'Sent, not read yet' : 'Not read'}</StatusIndicator>}
        </div>
      ))}
      {open && (
        <>
          <Textarea
            ref={ref}
            value={draft}
            rows={2}
            placeholder="Change of plan? Tell it here, like you would a teammate."
            onChange={({ detail }) => setDraft(detail.value)}
            // Ctrl/Cmd+Enter sends; plain Enter is a new line.
            onKeyDown={({ detail }) => detail.key === 'Enter' && (detail.ctrlKey || detail.metaKey) && submit()}
            invalid={tooLong}
            ariaLabel="Message"
          />
          {tooLong && <Box color="text-status-error" variant="small">Keep it under {NUDGE_MAX_MESSAGE_LENGTH} characters.</Box>}
          {send.isError && <Alert type="error">{send.error instanceof Error ? send.error.message : 'The message was not sent.'}</Alert>}
          <Box float="right">
            <Button variant="primary" onClick={submit} loading={send.isPending} disabled={!draft.trim() || tooLong}>Send</Button>
          </Box>
        </>
      )}
    </SpaceBetween>
  );
});
