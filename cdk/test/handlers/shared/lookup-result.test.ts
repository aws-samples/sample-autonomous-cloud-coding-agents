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

// The whole point of `LookupResult` is that "genuinely nothing" and "the lookup
// broke" stay distinguishable (#756 Cat 2 / AI004). Its two failure-ish variants
// share the `ok: false` tag, so the guards — not `switch` exhaustiveness — are
// what keep them apart. These tests lock the guards to the *variant*, not to
// `ok`, so a future third `ok: false` state can't quietly satisfy both.

import {
  LOOKUP_ABSENT,
  isLookupAbsent,
  isLookupFailure,
  lookupFailed,
  lookupFound,
  lookupValueOr,
  type LookupResult,
} from '../../../src/handlers/shared/lookup-result';

describe('lookupFound', () => {
  test('carries the value under ok: true', () => {
    expect(lookupFound(42)).toEqual({ ok: true, value: 42 });
  });

  test('treats falsy values as found, not absent', () => {
    // A lookup that legitimately resolves to 0 / '' / false / null must not be
    // re-collapsed into "nothing found" — that is the masking, one layer up.
    expect(lookupFound(0)).toEqual({ ok: true, value: 0 });
    expect(lookupFound('')).toEqual({ ok: true, value: '' });
    expect(lookupFound(false)).toEqual({ ok: true, value: false });
    expect(lookupFound(null)).toEqual({ ok: true, value: null });
  });
});

describe('LOOKUP_ABSENT', () => {
  test('is ok: false with absent set and NO error field', () => {
    // `'error' in r` is the discriminator both guards use, so the absent variant
    // must not carry the key at all — not even as undefined.
    expect(LOOKUP_ABSENT).toEqual({ ok: false, absent: true });
    expect('error' in LOOKUP_ABSENT).toBe(false);
  });
});

describe('lookupFailed', () => {
  test('carries the cause so a caller can log or escalate it', () => {
    const err = new Error('DDB unavailable');
    expect(lookupFailed(err)).toEqual({ ok: false, error: err });
  });

  test('carries a non-Error cause verbatim (GraphQL errors arrays are not Errors)', () => {
    const errors = [{ message: 'Authentication required' }];
    expect(lookupFailed(errors)).toEqual({ ok: false, error: errors });
  });

  test('an undefined cause is still a failure, not an absence', () => {
    // A thrown `undefined` is legal in JS. The variant must remain a failure —
    // `'error' in r` holds even when the value is undefined.
    const r = lookupFailed(undefined);
    expect(isLookupFailure(r)).toBe(true);
    expect(isLookupAbsent(r)).toBe(false);
  });
});

describe('isLookupFailure / isLookupAbsent', () => {
  test('are both false for a found result', () => {
    const r = lookupFound('v');
    expect(isLookupFailure(r)).toBe(false);
    expect(isLookupAbsent(r)).toBe(false);
  });

  test('separate absent from failed — the distinction the type exists for', () => {
    const absent: LookupResult<string> = LOOKUP_ABSENT;
    const failed: LookupResult<string> = lookupFailed(new Error('boom'));

    expect(isLookupAbsent(absent)).toBe(true);
    expect(isLookupFailure(absent)).toBe(false);

    expect(isLookupFailure(failed)).toBe(true);
    expect(isLookupAbsent(failed)).toBe(false);
  });

  test('are exact complements over the two ok: false variants', () => {
    // Guards against a regression where both guards accept (or both reject) the
    // same variant — which is how a failure ends up handled as an empty result.
    for (const r of [LOOKUP_ABSENT, lookupFailed('x')] as Array<LookupResult<string>>) {
      expect(isLookupAbsent(r)).toBe(!isLookupFailure(r));
    }
  });

  test('narrow to the variant fields for the type checker', () => {
    const failed: LookupResult<number> = lookupFailed(new Error('boom'));
    if (isLookupFailure(failed)) {
      expect((failed.error as Error).message).toBe('boom');
    } else {
      throw new Error('expected a failure result');
    }

    const absent: LookupResult<number> = LOOKUP_ABSENT;
    if (isLookupAbsent(absent)) {
      expect(absent.absent).toBe(true);
    } else {
      throw new Error('expected an absent result');
    }
  });
});

describe('lookupValueOr', () => {
  test('returns the value when found', () => {
    expect(lookupValueOr(lookupFound('pr-1'), null)).toBe('pr-1');
  });

  test('returns the fallback for BOTH absent and failed', () => {
    // The deliberate collapse for purely best-effort callers. Asserted so the
    // fact that it erases the absent/failed distinction stays explicit: any
    // caller that needs the distinction must branch BEFORE calling this.
    expect(lookupValueOr(LOOKUP_ABSENT as LookupResult<string>, null)).toBeNull();
    expect(lookupValueOr(lookupFailed(new Error('boom')) as LookupResult<string>, null)).toBeNull();
  });

  test('returns a falsy found value rather than the fallback', () => {
    expect(lookupValueOr(lookupFound(0), 99)).toBe(0);
    expect(lookupValueOr(lookupFound(''), 'fallback')).toBe('');
  });
});
