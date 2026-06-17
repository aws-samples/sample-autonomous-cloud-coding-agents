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

// Executable guard for the global Lambda-bundling disable (#366).
//
// The speedup in this package depends entirely on `test/setup/disable-bundling.ts`
// running as a Jest `setupFiles` entry. Until now the only regression guards
// were prose in AGENTS.md and a checklist item in review_pr.md — both
// honor-system. If someone drops the `setupFiles` wiring, reorders Jest setup,
// or a CDK rename breaks the context key, the suite silently reverts to a
// full-bundling (~15× slower) synth with no failing check. These assertions
// make that floor machine-enforced.
import { App, Stack } from 'aws-cdk-lib';

describe('global Lambda bundling disable', () => {
  it('sets aws:cdk:bundling-stacks to [] in the synth context', () => {
    // A bare `new App()` reads CDK_CONTEXT_JSON, which setupFiles populated.
    expect(new App().node.tryGetContext('aws:cdk:bundling-stacks')).toEqual([]);
  });

  it('makes a bare-App stack report bundlingRequired === false', () => {
    const stack = new Stack(new App(), 'BundlingProbe', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    expect(stack.bundlingRequired).toBe(false);
  });
});
