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

import { flush } from './_helpers';
import { renderPanel } from './_render';
import { MockDataSource } from '../../src/tui/api/source-mock';
import Policies from '../../src/tui/panels/Policies';

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
