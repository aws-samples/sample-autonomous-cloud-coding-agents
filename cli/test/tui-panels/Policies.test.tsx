/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

import Policies from '../../src/tui/panels/Policies';
import { renderPanel } from './_render';
import { flush } from './_helpers';
import { MockDataSource } from '../../src/tui/api/source-mock';

describe('Policies panel', () => {
  it('auto-selects the first repo in mock mode and shows hard + soft rules', async () => {
    const { lastFrame, unmount } = renderPanel(<Policies active />, {
      source: new MockDataSource(),
    });
    // Propagation chain (each step is at least one microtask):
    //   1. DataProvider.refresh() → repos populate
    //   2. Policies useEffect auto-selects first repo
    //   3. loadPolicies(repo) → policiesByRepo map update
    //   4. React re-renders with the hard/soft buckets
    // Each `flush()` yields 30ms + microtask drain; four is enough
    // padding to cover the chain even on slow CI runners.
    for (let i = 0; i < 4; i += 1) await flush();
    const frame = lastFrame() ?? '';
    // Title banner.
    expect(frame).toContain('Safety Policies');
    // Both tier headings are rendered.
    expect(frame).toContain('Blocked');
    expect(frame).toContain('Requires approval');
    // Known rule ids from the mock fixture.
    expect(frame).toContain('rm_slash');
    expect(frame).toContain('bash_exec_gate');
    unmount();
  });

  it('shows the selected repo in the header', async () => {
    const { lastFrame, unmount } = renderPanel(<Policies active />, {
      source: new MockDataSource(),
    });
    for (let i = 0; i < 4; i += 1) await flush();
    const frame = lastFrame() ?? '';
    // Mock fixture has `aws-samples/my-project` as the first active repo.
    expect(frame).toContain('aws-samples/my-project');
    unmount();
  });
});
