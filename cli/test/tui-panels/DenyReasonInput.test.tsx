/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

import { render } from 'ink-testing-library';
import DenyReasonInput from '../../src/tui/components/DenyReasonInput';
import { DENY_REASON_MAX_LENGTH } from '../../src/types';
import { flush, KEY_ENTER, KEY_ESC } from './_helpers';

describe('DenyReasonInput', () => {
  it('renders prompt + cap hint', () => {
    const { lastFrame, unmount } = render(
      <DenyReasonInput onConfirm={() => {}} onCancel={() => {}} />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Deny — optional reason');
    expect(frame).toContain(`0/${DENY_REASON_MAX_LENGTH}`);
    unmount();
  });

  it('accepts typed characters and updates the counter', async () => {
    const { lastFrame, stdin, unmount } = render(
      <DenyReasonInput onConfirm={() => {}} onCancel={() => {}} />,
    );
    stdin.write('no');
    await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('no');
    expect(frame).toContain(`2/${DENY_REASON_MAX_LENGTH}`);
    unmount();
  });

  it('confirms the trimmed reason on Enter', async () => {
    let reason: string | null = null;
    const { stdin, unmount } = render(
      <DenyReasonInput onConfirm={(r) => { reason = r; }} onCancel={() => {}} />,
    );
    stdin.write('stop');
    await flush();
    stdin.write(KEY_ENTER);
    await flush();
    expect(reason).toBe('stop');
    unmount();
  });

  it('cancels on Escape', async () => {
    let cancelled = false;
    const { stdin, unmount } = render(
      <DenyReasonInput onConfirm={() => {}} onCancel={() => { cancelled = true; }} />,
    );
    stdin.write(KEY_ESC);
    await flush();
    expect(cancelled).toBe(true);
    unmount();
  });

  it('confirms empty reason as empty string (agent gets denial with no note)', async () => {
    let reason: string | null = null;
    const { stdin, unmount } = render(
      <DenyReasonInput onConfirm={(r) => { reason = r; }} onCancel={() => {}} />,
    );
    stdin.write(KEY_ENTER);
    await flush();
    expect(reason).toBe('');
    unmount();
  });
});
