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

import {
  isLambdaMicrovmRegionSupported,
  LAMBDA_MICROVM_SUPPORTED_REGIONS,
} from '../../../src/handlers/shared/microvm-regions';

describe('LAMBDA_MICROVM_SUPPORTED_REGIONS', () => {
  test('lists exactly the 5 launch Regions from ADR-021', () => {
    expect([...LAMBDA_MICROVM_SUPPORTED_REGIONS]).toEqual([
      'us-east-1',
      'us-east-2',
      'us-west-2',
      'eu-west-1',
      'ap-northeast-1',
    ]);
  });

  test('has no duplicate entries', () => {
    expect(new Set(LAMBDA_MICROVM_SUPPORTED_REGIONS).size).toBe(LAMBDA_MICROVM_SUPPORTED_REGIONS.length);
  });
});

describe('isLambdaMicrovmRegionSupported', () => {
  test.each([...LAMBDA_MICROVM_SUPPORTED_REGIONS])('accepts the supported Region %s', (region) => {
    expect(isLambdaMicrovmRegionSupported(region)).toBe(true);
  });

  test('rejects a Region that has not launched the backend', () => {
    expect(isLambdaMicrovmRegionSupported('eu-central-1')).toBe(false);
    expect(isLambdaMicrovmRegionSupported('ap-southeast-2')).toBe(false);
  });

  test('rejects undefined and empty input rather than defaulting to supported', () => {
    // A missing AWS_REGION must never read as "supported" — the static gate is a
    // deny-by-default check, and the live probes are what self-heal false denials.
    expect(isLambdaMicrovmRegionSupported(undefined)).toBe(false);
    expect(isLambdaMicrovmRegionSupported('')).toBe(false);
  });

  test('compares Region ids verbatim (no case folding, no prefix matching)', () => {
    expect(isLambdaMicrovmRegionSupported('US-EAST-1')).toBe(false);
    expect(isLambdaMicrovmRegionSupported('us-east-1a')).toBe(false);
    expect(isLambdaMicrovmRegionSupported('us-east')).toBe(false);
  });
});
