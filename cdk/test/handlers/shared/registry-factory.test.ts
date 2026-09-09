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

import { makeRegistryClient } from '../../../src/handlers/shared/registry/factory';

describe('makeRegistryClient', () => {
  const originalRegistryId = process.env.AGENT_REGISTRY_ID;

  afterEach(() => {
    if (originalRegistryId === undefined) {
      delete process.env.AGENT_REGISTRY_ID;
    } else {
      process.env.AGENT_REGISTRY_ID = originalRegistryId;
    }
  });

  test('explains how to resolve registry references when the feature is disabled', () => {
    delete process.env.AGENT_REGISTRY_ID;

    expect(() => makeRegistryClient()).toThrow(
      'remove registry:// refs or deploy with enableAgentRegistry=true',
    );
  });
});
