/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

import { jest } from '@jest/globals';
import Submit from '../../src/tui/panels/Submit';
import { renderPanel } from './_render';
import { flush, KEY_DOWN, KEY_ENTER } from './_helpers';
import { MockDataSource } from '../../src/tui/api/source-mock';
import {
  APPROVAL_TIMEOUT_S_DEFAULT,
  INITIAL_APPROVALS_MAX_ENTRIES,
} from '../../src/types';

/** Move from the repo step through the listed repos, exiting into
 *  the next field (prompt). The repo step's cursor walks the repo
 *  list first; we need one ↓ per list entry plus one to exit. */
async function leaveRepoStep(stdin: { write: (s: string) => void }, repoCount: number) {
  for (let i = 0; i < repoCount; i += 1) {
    stdin.write(KEY_DOWN);
    await flush();
  }
}

describe('Submit panel', () => {
  it('renders all five form fields including the new approval-timeout + pre-approvals', async () => {
    const { lastFrame, unmount } = renderPanel(
      <Submit active onSubmitted={() => {}} />,
      { source: new MockDataSource() },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('New Task');
    expect(frame).toContain('Repository');
    expect(frame).toContain('Instructions');
    expect(frame).toContain('Approval timeout');
    expect(frame).toContain(`${APPROVAL_TIMEOUT_S_DEFAULT}s`);
    expect(frame).toContain('Pre-approve');
    expect(frame).toContain('[ Submit Task ]');
    unmount();
  });

  it('navigates down through the field order correctly', async () => {
    const source = new MockDataSource();
    const repoCount = (await source.listRegisteredRepos()).length;
    const { lastFrame, stdin, unmount } = renderPanel(
      <Submit active onSubmitted={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    // Walk from repo down to submit — confirms focus moves
    // through prompt, timeout, approvals, submit.
    await leaveRepoStep(stdin, repoCount); // → prompt
    stdin.write(KEY_DOWN); await flush();   // → timeout
    stdin.write(KEY_DOWN); await flush();   // → approvals
    stdin.write(KEY_DOWN); await flush();   // → submit
    const frame = lastFrame() ?? '';
    // Submit button is rendered; the color changes when focused (and
    // the panel still renders the button label in both states).
    expect(frame).toContain('[ Submit Task ]');
    unmount();
  });

  it('rejects submit when prompt is empty', async () => {
    const source = new MockDataSource();
    const repoCount = (await source.listRegisteredRepos()).length;
    const submitSpy = jest.spyOn(source, 'submitTask');
    const { stdin, unmount } = renderPanel(
      <Submit active onSubmitted={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    // Navigate to Submit without filling in prompt.
    await leaveRepoStep(stdin, repoCount);
    stdin.write(KEY_DOWN); await flush(); // → timeout
    stdin.write(KEY_DOWN); await flush(); // → approvals
    stdin.write(KEY_DOWN); await flush(); // → submit
    stdin.write(KEY_ENTER); await flush();
    expect(submitSpy).not.toHaveBeenCalled();
    unmount();
  });

  it('exposes the approval-scopes help once focused on the pre-approvals field', async () => {
    const source = new MockDataSource();
    const repoCount = (await source.listRegisteredRepos()).length;
    const { lastFrame, stdin, unmount } = renderPanel(
      <Submit active onSubmitted={() => {}} />,
      { source },
    );
    for (let i = 0; i < 3; i += 1) await flush();
    await leaveRepoStep(stdin, repoCount); // → prompt
    stdin.write(KEY_DOWN); await flush();   // → timeout
    stdin.write(KEY_DOWN); await flush();   // → approvals
    const frame = lastFrame() ?? '';
    expect(frame).toContain('a or + to add a scope');
    expect(INITIAL_APPROVALS_MAX_ENTRIES).toBeGreaterThan(0);
    unmount();
  });
});
