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

import { microvmErrorIdentity, microvmRequestIdentity } from '../../../src/handlers/shared/microvm-control';

test.each([undefined, null, {}, { $metadata: {} }, { $metadata: { requestId: 'bad\nsecret' } }])(
  'omits absent or malformed request metadata: %j', response => {
    expect(microvmRequestIdentity(response)).toEqual({});
  },
);

test('keeps only the request ID from a successful reply', () => {
  expect(microvmRequestIdentity({
    $metadata: { requestId: 'aws-123', headers: { authorization: 'secret' } }, payload: 'secret',
  })).toEqual({ aws_request_id: 'aws-123' });
});

test('uses the original SDK identity behind a wrapper without copying messages', () => {
  expect(microvmErrorIdentity(Object.assign(new Error('private wrapper'), {
    cause: Object.assign(new Error('private SDK detail'), {
      name: 'AccessDeniedException', $metadata: { requestId: 'aws-456' },
    }),
  }))).toEqual({ error_type: 'AccessDeniedException', aws_request_id: 'aws-456' });
});

test('rejects malformed error names and request IDs', () => {
  expect(microvmErrorIdentity({
    name: 'private\ncontent', $metadata: { requestId: 'secret'.repeat(30) },
  })).toEqual({ error_type: 'Error' });
});
