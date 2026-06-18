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
 * Shared guard for HMAC signing secrets — the single chokepoint for the
 * "never HMAC with an empty key" invariant.
 *
 * HMAC('', input) is computable by anyone, so an empty or whitespace-only
 * signing secret makes every signature forgeable. All webhook verifiers
 * (GitHub, Linear, Slack, generic webhook-create-task) MUST route their
 * secret through this check both when fetching from Secrets Manager and
 * again inside the verify function (defense-in-depth for secrets sourced
 * elsewhere, e.g. per-workspace OAuth bundles).
 *
 * When wiring a NEW webhook source, call this in both places — the
 * per-verifier unit tests cannot structurally force a verifier they
 * don't know about to honor the invariant.
 */
export function isUsableHmacSecret(secret: string | undefined | null): secret is string {
  return typeof secret === 'string' && secret.trim() !== '';
}
