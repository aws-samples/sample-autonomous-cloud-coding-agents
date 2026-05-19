import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import figures from 'figures';
import { useEditing } from '../context.js';
import { useData } from '../hooks/useData.js';
import ScopePicker from '../components/ScopePicker.js';
import { useBracketedPaste } from '../utils/bracketed-paste.js';
import {
  readClipboardImage,
  shouldShowHintOnce,
  type ClipboardReadResult,
} from '../utils/clipboard.js';
import {
  APPROVAL_TIMEOUT_S_DEFAULT,
  APPROVAL_TIMEOUT_S_MAX,
  APPROVAL_TIMEOUT_S_MIN,
  INITIAL_APPROVALS_MAX_ENTRIES,
  type ApprovalScope,
  type Attachment,
} from '../../types.js';

interface SubmitProps {
  active: boolean;
  onSubmitted: (taskId: string) => void;
}

type Field = 'repo' | 'prompt' | 'timeout' | 'approvals' | 'attachments' | 'submit';
const FIELDS: Field[] = ['repo', 'prompt', 'timeout', 'approvals', 'attachments', 'submit'];

/** UX cap on number of attachments. Server has no documented cap;
 *  this is a guard against UI-driven runaway pastes. */
const MAX_ATTACHMENTS = 10;

/** Local-only attachment row that pairs the wire shape with a
 *  display-friendly size hint. The wire shape (`Attachment`) is
 *  what we forward on submit. */
interface AttachmentRow {
  readonly attachment: Attachment;
  readonly sizeBytes: number;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const Submit: React.FC<SubmitProps> = ({ active, onSubmitted }) => {
  const { setEditing } = useEditing();
  const { snapshot, submitTask } = useData();
  const repos = snapshot.repos;

  const [field, setField] = useState<Field>('repo');
  const [repoCursor, setRepoCursor] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [timeoutText, setTimeoutText] = useState(String(APPROVAL_TIMEOUT_S_DEFAULT));
  const [preApprovals, setPreApprovals] = useState<ApprovalScope[]>([]);
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);
  const [showScopePicker, setShowScopePicker] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [editingText, setEditingText] = useState<'prompt' | 'timeout' | null>(null);
  /** Transient one-line message under the attachments row. Cleared
   *  after `TOAST_DURATION_MS`. Used for both success and failure
   *  signals so the user always gets feedback for a paste action. */
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  const submitTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const toastTimer = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);

  const fieldIdx = FIELDS.indexOf(field);
  const selectedRepo = repos[repoCursor]?.repo ?? '';

  useEffect(() => {
    if (showScopePicker) {
      setEditing(true, 'scope-picker');
    } else if (editingText) {
      setEditing(true, 'text');
    } else {
      setEditing(false);
    }
    return () => setEditing(false);
  }, [editingText, showScopePicker, setEditing]);

  useEffect(() => () => {
    if (submitTimer.current) clearTimeout(submitTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const showToast = useCallback((text: string, tone: 'ok' | 'warn' | 'err') => {
    setToast({ text, tone });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = globalThis.setTimeout(() => setToast(null), 4000);
  }, []);

  /** Try to grab an image from the clipboard and append it. Used by
   *  both the Ctrl+V keybind (manual fallback) and the
   *  bracketed-paste hook (Cmd+V on macOS). */
  const tryPasteFromClipboard = useCallback(async () => {
    if (!active || submitted || showScopePicker) return;
    if (attachments.length >= MAX_ATTACHMENTS) {
      showToast(`Attachment cap reached (${MAX_ATTACHMENTS})`, 'warn');
      return;
    }
    let result: ClipboardReadResult;
    try {
      result = await readClipboardImage();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Clipboard read failed: ${msg}`, 'err');
      return;
    }
    if (result.ok) {
      const ext = result.image.mediaType.split('/')[1];
      const filename = `pasted-${Date.now()}.${ext}`;
      const att: AttachmentRow = {
        attachment: {
          type: 'image',
          content_type: result.image.mediaType,
          data: result.image.base64,
          filename,
        },
        sizeBytes: result.image.sizeBytes,
      };
      setAttachments(prev => [...prev, att]);
      showToast(
        `${figures.tick} Pasted image (${formatBytes(result.image.sizeBytes)})`,
        'ok',
      );
      return;
    }
    // Failure dispatch — keep messages concise + actionable.
    const f = result.failure;
    switch (f.kind) {
      case 'empty':
        showToast('Clipboard is empty', 'warn');
        break;
      case 'not_image':
        showToast('Clipboard does not contain an image', 'warn');
        break;
      case 'too_large':
        showToast(
          `Image too large: ${formatBytes(f.sizeBytes)} > ${formatBytes(f.maxBytes)}`,
          'err',
        );
        break;
      case 'tool_missing':
        // Hint cap: only show the multi-line install hint once per
        // session so a user with a missing tool isn't drowned in
        // identical toasts. The shorter "press paste failed" toast
        // still fires every time so they know the action did
        // something.
        if (shouldShowHintOnce(`tool-missing-${f.platform}`)) {
          showToast(f.hint, 'err');
        } else {
          showToast('Clipboard tool missing — see earlier hint', 'err');
        }
        break;
      case 'unsupported_platform':
        showToast(`Clipboard paste not yet supported on ${f.platform}`, 'err');
        break;
      case 'error':
        showToast(`Clipboard read error: ${f.message}`, 'err');
        break;
    }
  }, [active, submitted, showScopePicker, attachments.length, showToast]);

  // Bracketed-paste hook: Cmd+V (macOS native paste action) goes
  // through this path. The terminal's paste action emits the
  // bracketed-paste start marker; we read the OS clipboard right
  // away while it still holds the image. Disabled when the panel
  // is inactive so other panels' input isn't intercepted.
  useBracketedPaste({
    enabled: active && !submitted,
    onPaste: () => { void tryPasteFromClipboard(); },
  });

  const parsedTimeout = Number(timeoutText);
  const timeoutValid =
    Number.isInteger(parsedTimeout)
    && parsedTimeout >= APPROVAL_TIMEOUT_S_MIN
    && parsedTimeout <= APPROVAL_TIMEOUT_S_MAX;

  useInput(useCallback((input, key) => {
    if (!active || submitted) return;
    // The scope picker owns input while mounted.
    if (showScopePicker) return;

    // Ctrl+V — manual paste trigger that works anywhere in the form,
    // independently of bracketed-paste support. Useful for terminals
    // without bracketed paste, and as a belt-and-suspenders backup.
    if (key.ctrl && (input === 'v' || input === 'V')) {
      void tryPasteFromClipboard();
      return;
    }

    // ── Text editing mode ──
    if (editingText === 'prompt') {
      if (key.escape || key.return) { setEditingText(null); return; }
      if (key.backspace || key.delete) { setPrompt(p => p.slice(0, -1)); return; }
      if (input && !key.ctrl && !key.meta) { setPrompt(p => p + input); }
      return;
    }
    if (editingText === 'timeout') {
      if (key.escape || key.return) { setEditingText(null); return; }
      if (key.backspace || key.delete) { setTimeoutText(p => p.slice(0, -1)); return; }
      if (input && /[0-9]/.test(input) && timeoutText.length < 5) {
        setTimeoutText(p => p + input);
      }
      return;
    }

    // ── Repo selector ──
    if (field === 'repo') {
      if (key.upArrow) {
        if (repoCursor > 0) setRepoCursor(c => c - 1);
        return;
      }
      if (key.downArrow) {
        if (repoCursor < repos.length - 1) setRepoCursor(c => c + 1);
        else setField('prompt');
        return;
      }
      if (input === ' ' || key.return) { setField('prompt'); return; }
      return;
    }

    // ── Approvals list ──
    if (field === 'approvals') {
      if (input === '+' || input === 'a') {
        if (preApprovals.length >= INITIAL_APPROVALS_MAX_ENTRIES) return;
        setShowScopePicker(true);
        return;
      }
      if (input === '-' || input === 'd' || key.delete || key.backspace) {
        // Remove the last scope for simplicity. A richer UX would
        // let you cursor-pick, but this matches the CLI `--pre-approve`
        // repeatable-flag ergonomics.
        setPreApprovals(p => p.slice(0, -1));
        return;
      }
      // fall through to field navigation
    }

    // ── Attachments list ──
    if (field === 'attachments') {
      // `-` or `d` removes last; `r` clears all. `Ctrl+V` (handled
      // earlier in the function) adds. Plain `v` does NOT add — the
      // user might be trying to type "v" elsewhere, and we've already
      // taught them Ctrl+V from the help bar.
      if (input === '-' || input === 'd' || key.delete || key.backspace) {
        setAttachments(prev => prev.slice(0, -1));
        return;
      }
      if (input === 'r' || input === 'R') {
        setAttachments([]);
        return;
      }
      // fall through to field navigation
    }

    // ── General field navigation ──
    if (key.downArrow) {
      const next = Math.min(fieldIdx + 1, FIELDS.length - 1);
      setField(FIELDS[next]);
      if (FIELDS[next] === 'repo') setRepoCursor(0);
      return;
    }
    if (key.upArrow) {
      const prev = Math.max(fieldIdx - 1, 0);
      setField(FIELDS[prev]);
      if (FIELDS[prev] === 'repo') setRepoCursor(repos.length - 1);
      return;
    }

    // Prompt text editing
    if (field === 'prompt' && key.return) { setEditingText('prompt'); return; }
    // Timeout text editing
    if (field === 'timeout' && key.return) { setEditingText('timeout'); return; }

    // Submit
    if (field === 'submit' && key.return) {
      if (!selectedRepo || !prompt || !timeoutValid) return;
      setSubmitted(true);
      setSubmitError(null);
      void (async () => {
        try {
          const wireAttachments: readonly Attachment[] = attachments.map(a => a.attachment);
          const row = await submitTask({
            repo: selectedRepo,
            task_description: prompt,
            approval_timeout_s: parsedTimeout,
            ...(preApprovals.length > 0 && { initial_approvals: preApprovals }),
            ...(wireAttachments.length > 0 && { attachments: wireAttachments }),
          });
          submitTimer.current = globalThis.setTimeout(() => onSubmitted(row.task_id), 500);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          setSubmitError(msg);
          setSubmitted(false);
        }
      })();
      return;
    }
  }, [
    active, submitted, editingText, showScopePicker, field, fieldIdx,
    repoCursor, repos, prompt, timeoutText, timeoutValid, parsedTimeout,
    preApprovals, attachments, selectedRepo, submitTask, onSubmitted,
    tryPasteFromClipboard,
  ]));

  const handleAddScope = useCallback((scope: ApprovalScope) => {
    setPreApprovals(p => (p.includes(scope) ? p : [...p, scope]));
    setShowScopePicker(false);
  }, []);

  if (submitted && !submitError) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="green" bold>{figures.tick} Task submitted!</Text>
        <Text dimColor>Repo: {selectedRepo}  |  Switching to Watch…</Text>
      </Box>
    );
  }

  const cur = (f: Field) => field === f && active ? figures.pointer + ' ' : '  ';
  const fc = (f: Field) => field === f && active ? 'cyan' : undefined;
  const toastColor =
    toast?.tone === 'ok' ? 'green'
    : toast?.tone === 'warn' ? 'yellow'
    : 'red';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold>New Task</Text>
        <Text dimColor>  {figures.arrowUp}/{figures.arrowDown} navigate · Enter edit/select · a/+ scope · Ctrl+V paste image</Text>
      </Box>

      {/* Repo selector */}
      <Box flexDirection="column">
        <Box>
          <Text color={fc('repo')}>{cur('repo')}</Text>
          <Text dimColor>Repository:       </Text>
          {field !== 'repo' && <Text bold>{selectedRepo || '(none)'}</Text>}
        </Box>
        {field === 'repo' && (
          <Box marginLeft={4} flexDirection="column">
            {repos.length === 0 ? (
              <Text dimColor>No repos discovered yet. Submit via CLI or wait for refresh.</Text>
            ) : repos.map((r, i) => {
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
        <Text dimColor>Instructions:     </Text>
        <Text bold={field === 'prompt'}>{prompt || '(empty)'}</Text>
        {field === 'prompt' && editingText === 'prompt' && <Text color="cyan">|</Text>}
        {field === 'prompt' && editingText !== 'prompt' && !prompt && <Text dimColor>  Enter to type</Text>}
      </Box>

      {/* Approval timeout */}
      <Box>
        <Text color={fc('timeout')}>{cur('timeout')}</Text>
        <Text dimColor>Approval timeout: </Text>
        <Text bold={field === 'timeout'} color={timeoutValid ? undefined : 'red'}>{timeoutText}s</Text>
        {field === 'timeout' && editingText === 'timeout' && <Text color="cyan">|</Text>}
        <Text dimColor>  ({APPROVAL_TIMEOUT_S_MIN}-{APPROVAL_TIMEOUT_S_MAX}s, default {APPROVAL_TIMEOUT_S_DEFAULT})</Text>
        {!timeoutValid && <Text color="red">  {figures.cross} invalid</Text>}
      </Box>

      {/* Pre-approvals */}
      <Box flexDirection="column">
        <Box>
          <Text color={fc('approvals')}>{cur('approvals')}</Text>
          <Text dimColor>Pre-approve:      </Text>
          {preApprovals.length === 0 ? (
            <Text dimColor>(none — agent asks for everything)</Text>
          ) : (
            <Text>{preApprovals.length} scope{preApprovals.length !== 1 ? 's' : ''}</Text>
          )}
        </Box>
        {field === 'approvals' && (
          <Box marginLeft={4} flexDirection="column">
            {preApprovals.length === 0 ? (
              <Text dimColor>  a or + to add a scope</Text>
            ) : (
              <>
                {preApprovals.map(s => (
                  <Box key={s}>
                    <Text color="green">  {figures.tick} </Text>
                    <Text>{s}</Text>
                  </Box>
                ))}
                <Text dimColor>  a/+ add  |  d/- remove last  |  {preApprovals.length}/{INITIAL_APPROVALS_MAX_ENTRIES}</Text>
              </>
            )}
          </Box>
        )}
      </Box>

      {/* Attachments */}
      <Box flexDirection="column">
        <Box>
          <Text color={fc('attachments')}>{cur('attachments')}</Text>
          <Text dimColor>Attachments:      </Text>
          {attachments.length === 0 ? (
            <Text dimColor>(none — Ctrl+V or Cmd+V to paste a screenshot)</Text>
          ) : (
            <Text>{attachments.length}/{MAX_ATTACHMENTS}</Text>
          )}
        </Box>
        {field === 'attachments' && attachments.length > 0 && (
          <Box marginLeft={4} flexDirection="column">
            {attachments.map((a, i) => (
              <Box key={i}>
                <Text color="green">  {figures.tick} </Text>
                <Text dimColor>{a.attachment.content_type ?? a.attachment.type}</Text>
                <Text>  {formatBytes(a.sizeBytes)}</Text>
                {a.attachment.filename && (
                  <Text dimColor>  {a.attachment.filename}</Text>
                )}
              </Box>
            ))}
            <Text dimColor>  Ctrl+V add  |  d/- remove last  |  r reset  |  {attachments.length}/{MAX_ATTACHMENTS}</Text>
          </Box>
        )}
        {field === 'attachments' && attachments.length === 0 && (
          <Box marginLeft={4} flexDirection="column">
            <Text dimColor>  Ctrl+V (or Cmd+V on macOS) to paste an image from clipboard</Text>
          </Box>
        )}
      </Box>

      {toast && (
        <Box marginTop={1} flexDirection="column">
          {toast.text.split('\n').map((line, i) => (
            <Box key={i}>
              <Text color={toastColor}>{line}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Text> </Text>

      {/* Submit button */}
      <Box>
        <Text color={fc('submit')}>{cur('submit')}</Text>
        <Text bold color={field === 'submit' ? 'green' : 'gray'}>{'[ Submit Task ]'}</Text>
        {field === 'submit' && (!selectedRepo || !prompt || !timeoutValid) && (
          <Text color="red">  {figures.cross} fix fields above first</Text>
        )}
      </Box>

      {submitError && (
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color="red" bold>{figures.cross} Submit failed</Text>
          </Box>
          {/* Split on newlines so the ApiClient's multi-line error
              messages (status line + server body) all render cleanly
              rather than getting trimmed to one line. */}
          {submitError.split(/\r?\n/).map((line, i) => (
            <Box key={i}>
              <Text color="red">  {line}</Text>
            </Box>
          ))}
          {/[34]0\d: /.test(submitError) && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Diagnostic hints:</Text>
              <Text dimColor>  • 401 → token expired: run `bgagent login`</Text>
              <Text dimColor>  • 403 → repo may not be onboarded / GitHub App missing; verify with</Text>
              <Text dimColor>    `bgagent policies list --repo {selectedRepo}`</Text>
              <Text dimColor>  • 404 → repo not registered; run onboarding first</Text>
            </Box>
          )}
        </Box>
      )}

      {showScopePicker && (
        <ScopePicker
          heading="Add pre-approval scope"
          onConfirm={handleAddScope}
          onCancel={() => setShowScopePicker(false)}
        />
      )}
    </Box>
  );
};

export default Submit;
