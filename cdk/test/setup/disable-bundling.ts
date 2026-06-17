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

// Disable Lambda asset bundling during unit-test synthesis.
//
// `Template.fromStack()` triggers a full CDK synth, which bundles every
// NodejsFunction via esbuild — ~28s for the AgentStack (413 resources). Unit
// tests assert on CloudFormation structure/properties, not bundled Lambda code,
// so for those assertions bundling is overhead — plus a smoke-test of Lambda
// `entry` resolution and handler compilation that unit tests intentionally cede
// to the `agent/` build (real synth/deploy still bundles). Skipping it cuts a
// single synth ~15× (~28.7s -> ~1.9s). See #366.
//
// `aws:cdk:bundling-stacks: []` tells the CLI/synth to bundle no stacks. CDK
// reads CDK_CONTEXT_JSON when an `App` is constructed, so a bare `new App()`
// (the overwhelming-majority pattern in our tests) picks this up with no
// call-site changes.
//
// Precedence matters for the opt-out. CDK's `App.loadContext(props.context,
// props.postCliContext)` applies `props.context` FIRST, then overwrites it with
// CDK_CONTEXT_JSON, then applies `postCliContext` LAST. So for this key the env
// var beats constructor `context` — `new App({ context: { 'aws:cdk:bundling-
// stacks': ['**'] } })` does NOT re-enable bundling (the env var clobbers it).
//
// This does NOT stop tests from synthesizing — `Template.fromStack()` still
// runs a full synth; it only skips the esbuild asset-bundling step within that
// synth. The opt-out below exists solely for the rare test that needs the
// *bundled-asset output itself* (e.g. asserting on a real asset hash / S3 key),
// where an unbundled synth would silently yield a placeholder value. Such a
// test must opt out via `postCliContext` (which wins over the env var),
// constructing its `App` with
// `new App({ postCliContext: { 'aws:cdk:bundling-stacks': ['**'] } })`
// (or the specific stack id).
const BUNDLING_DISABLED_CONTEXT = { 'aws:cdk:bundling-stacks': [] as string[] };

const existing = process.env.CDK_CONTEXT_JSON;
if (existing) {
  // Preserve any ambient context, but let the bundling disable win
  // unconditionally: a pre-set CDK_CONTEXT_JSON that carries
  // `aws:cdk:bundling-stacks` must not silently re-enable bundling and defeat
  // the speedup. The documented per-test opt-out is `postCliContext` (applied
  // AFTER the env var regardless — see above), so spreading our key LAST keeps
  // that escape hatch working while making the global disable robust to
  // whatever the environment already set.
  let ambient: Record<string, unknown>;
  try {
    ambient = JSON.parse(existing);
  } catch {
    // Without this guard a malformed pre-set var throws here, inside
    // `setupFiles`, and fails EVERY test in EVERY file with an opaque parse
    // error. Re-throw with the offending value so the blame is localized.
    throw new Error(`malformed CDK_CONTEXT_JSON in environment (must be valid JSON): ${existing}`);
  }
  const merged = { ...ambient, ...BUNDLING_DISABLED_CONTEXT };
  process.env.CDK_CONTEXT_JSON = JSON.stringify(merged);
} else {
  process.env.CDK_CONTEXT_JSON = JSON.stringify(BUNDLING_DISABLED_CONTEXT);
}
