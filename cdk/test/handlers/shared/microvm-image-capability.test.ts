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

// SPDX-License-Identifier: MIT-0

import sharedConstants from '../../../../contracts/constants.json';
import {
  MICROVM_IMAGE_PROTOCOL_ENV, MICROVM_LIFECYCLE_PROTOCOL, readMicrovmImageMetadata,
  supportsMicrovmLifecycle, verifyMicrovmImageLifecycle,
} from '../../../src/handlers/shared/microvm-image-capability';

const identity = {
  imageArn: 'arn:aws:lambda:us-east-1:123456789012:microvm-image:test',
  imageVersion: '3.0',
};
type Version = Parameters<typeof verifyMicrovmImageLifecycle>[1];
const version = (): Version => ({
  ...identity,
  environmentVariables: { [MICROVM_IMAGE_PROTOCOL_ENV]: MICROVM_LIFECYCLE_PROTOCOL },
  hooks: {
    port: sharedConstants.microvm_lifecycle.hook_port,
    microvmImageHooks: { ready: 'ENABLED', validate: 'ENABLED' },
    microvmHooks: {
      run: 'ENABLED',
      terminate: 'ENABLED',
      suspend: 'ENABLED',
      resume: 'ENABLED',
      suspendTimeoutInSeconds: sharedConstants.microvm_hook_budgets.lifecycle_hook_timeout_seconds,
      resumeTimeoutInSeconds: sharedConstants.microvm_hook_budgets.lifecycle_hook_timeout_seconds,
    },
  },
});

test('verifies the exact launched version and its compatible hooks and marker', () => {
  expect(verifyMicrovmImageLifecycle(identity, version())).toBe(true);
  // Deactivation only blocks new launches; it does not rewrite an existing snapshot.
  const inactive = { ...version(), status: 'INACTIVE' };
  expect(verifyMicrovmImageLifecycle(identity, inactive)).toBe(true);
});

test.each([
  ['different image', (v: Version) => { v.imageArn += '-other'; }],
  ['different version', (v: Version) => { v.imageVersion = '4.0'; }],
  ['no marker', (v: Version) => { v.environmentVariables = {}; }],
  ['wrong protocol', (v: Version) => { v.environmentVariables![MICROVM_IMAGE_PROTOCOL_ENV] = '999'; }],
  ['wrong port', (v: Version) => { v.hooks!.port = 8081; }],
  ['no hooks', (v: Version) => { v.hooks = undefined; }],
  ['no ready', (v: Version) => { v.hooks!.microvmImageHooks!.ready = 'DISABLED'; }],
  ['no validate', (v: Version) => { v.hooks!.microvmImageHooks!.validate = 'DISABLED'; }],
  ['no run', (v: Version) => { v.hooks!.microvmHooks!.run = 'DISABLED'; }],
  ['no terminate', (v: Version) => { v.hooks!.microvmHooks!.terminate = 'DISABLED'; }],
  ['no suspend', (v: Version) => { v.hooks!.microvmHooks!.suspend = 'DISABLED'; }],
  ['no resume', (v: Version) => { v.hooks!.microvmHooks!.resume = 'DISABLED'; }],
  ['short suspend', (v: Version) => { v.hooks!.microvmHooks!.suspendTimeoutInSeconds = 1; }],
  ['short resume', (v: Version) => { v.hooks!.microvmHooks!.resumeTimeoutInSeconds = 1; }],
  ['unknown suspend budget', (v: Version) => { v.hooks!.microvmHooks!.suspendTimeoutInSeconds = undefined; }],
  ['fractional resume budget', (v: Version) => { v.hooks!.microvmHooks!.resumeTimeoutInSeconds = 30.5; }],
] as const)('rejects %s', (_label, mutate) => {
  const changed = version();
  mutate(changed);
  expect(verifyMicrovmImageLifecycle(identity, changed)).toBe(false);
});

test.each([undefined, null, [], {}, { lifecycleProtocol: '1' }, { ...identity, imageArn: 1 },
  { ...identity, imageVersion: ' 3.0' }, { ...identity, imageArn: 'a\nb' }])('malformed metadata never invents image capability: %j', value => {
  expect(readMicrovmImageMetadata(value)).toEqual({});
  expect(supportsMicrovmLifecycle(value)).toBe(false);
});

test('legacy and unsupported metadata preserve identity without claiming lifecycle support', () => {
  for (const lifecycleProtocol of [undefined, '999']) {
    const metadata = { ...identity, lifecycleProtocol };
    expect(readMicrovmImageMetadata(metadata)).toEqual(identity);
    expect(supportsMicrovmLifecycle(metadata)).toBe(false);
  }
  const capable = { ...identity, lifecycleProtocol: MICROVM_LIFECYCLE_PROTOCOL };
  expect(readMicrovmImageMetadata({ ...capable, untrustedExtra: 'drop-me' })).toEqual(capable);
  expect(supportsMicrovmLifecycle(capable)).toBe(true);
});
