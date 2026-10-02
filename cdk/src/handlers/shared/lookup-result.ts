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

/**
 * Outcome of a best-effort lookup (a network/DDB read that may legitimately
 * find nothing). It exists to stop the silent-success-masking class (#756 Cat 2,
 * AI004): returning a bare `null`/`[]` from a `catch` collapses "genuinely
 * absent" into "the lookup broke", so the caller — and any orchestration
 * control flow keyed off it — cannot tell a real empty from an outage.
 *
 * Three states, deliberately distinct:
 * - `{ ok: true, value }`      — the lookup ran and found a value.
 * - `{ ok: false, absent: true }` — the lookup ran and there is genuinely nothing.
 * - `{ ok: false, error }`     — the lookup itself failed (throw / non-2xx / bad body).
 *
 * Callers that must route differently on failure (e.g. avoid posting a
 * duplicate comment, or escalate a retry) branch on {@link isLookupFailure}.
 * Purely best-effort callers that legitimately treat absent === failed can
 * collapse with {@link lookupValueOr} — but the failure is now still
 * *observable* at the source, which is the point.
 */
export type LookupResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly absent: true }
  | { readonly ok: false; readonly error: unknown };

/** The lookup ran and found `value`. */
export const lookupFound = <T>(value: T): LookupResult<T> => ({ ok: true, value });

/**
 * The lookup ran and there is genuinely nothing to find (not an error).
 *
 * Reserve this for an answered query with an empty answer. A precondition that
 * never let the query run — an unset env var, a missing table name — is a
 * failure: use {@link lookupFailed}. Conflating the two is the masking this
 * type exists to end, even where the two branches happen to behave alike today.
 */
export const LOOKUP_ABSENT = { ok: false, absent: true } as const;

/** The lookup itself failed — carries the cause for logging/escalation. */
export const lookupFailed = (error: unknown): LookupResult<never> => ({ ok: false, error });

/** True only for the genuine-failure variant (not the absent variant). */
export const isLookupFailure = <T>(
  r: LookupResult<T>,
): r is { readonly ok: false; readonly error: unknown } => !r.ok && 'error' in r;

/**
 * True only for the genuine-absence variant (not the failure variant).
 *
 * The companion to {@link isLookupFailure}, so "genuinely nothing" can be named
 * at a call site rather than inferred from a bare `!r.ok` — which also catches
 * failure — or from an inlined `!('error' in r)`. The two `ok: false` variants
 * share their tag, so the union is not single-tag discriminated and `switch`
 * exhaustiveness is unavailable; these two guards are the intended narrowing.
 * A state added to the union later MUST get a guard here, or it silently falls
 * into whichever `!r.ok` branch each caller happens to have written.
 */
export const isLookupAbsent = <T>(
  r: LookupResult<T>,
): r is { readonly ok: false; readonly absent: true } => !r.ok && !('error' in r);

/**
 * Collapse to the found value, or `fallback` when absent OR failed. For purely
 * best-effort callers that legitimately treat both the same; the failure was
 * already surfaced (logged) at the lookup site, so nothing is masked here.
 */
export const lookupValueOr = <T, F>(r: LookupResult<T>, fallback: F): T | F =>
  r.ok ? r.value : fallback;
