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

import { App, Stack } from 'aws-cdk-lib';

describe('global Lambda bundling disable', () => {
  it('sets aws:cdk:bundling-stacks to [] in the synth context', () => {
    expect(new App().node.tryGetContext('aws:cdk:bundling-stacks')).toEqual([]);
  });

  it('makes a bare-App stack report bundlingRequired === false', () => {
    const stack = new Stack(new App(), 'BundlingProbe', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    expect(stack.bundlingRequired).toBe(false);
  });
});

describe('per-test bundling opt-out (#366)', () => {
  it('re-enables bundling via postCliContext (the documented opt-out)', () => {
    const app = new App({ postCliContext: { 'aws:cdk:bundling-stacks': ['**'] } });
    const stack = new Stack(app, 'OptOutProbe', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    expect(stack.bundlingRequired).toBe(true);
  });

  it('does NOT re-enable bundling via constructor context (env var clobbers it)', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': ['**'] } });
    const stack = new Stack(app, 'ContextOptOutProbe', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    expect(stack.bundlingRequired).toBe(false);
  });
});
