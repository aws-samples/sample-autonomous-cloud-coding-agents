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
// so bundling is pure overhead here: skipping it cuts a single synth ~15×
// (~28.7s -> ~1.9s). See #366 and docs/design/CI_BUILD_PERFORMANCE.md.
//
// `aws:cdk:bundling-stacks: []` tells the CLI/synth to bundle no stacks. CDK
// reads CDK_CONTEXT_JSON when an `App` is constructed, so a bare `new App()`
// (the overwhelming-majority pattern in our tests) picks this up with no
// call-site changes. Tests that pass their own `{ context }` still merge on top.
//
// If a test ever needs real bundled assets (e.g. asserting on an asset hash /
// S3 key), it must opt out by constructing its `App` with
// `aws:cdk:bundling-stacks: ['**']` (or the specific stack id) in its context.
const BUNDLING_DISABLED_CONTEXT = { 'aws:cdk:bundling-stacks': [] as string[] };

const existing = process.env.CDK_CONTEXT_JSON;
if (existing) {
  // Preserve any context already provided; our key wins only if unset.
  const merged = { ...BUNDLING_DISABLED_CONTEXT, ...JSON.parse(existing) };
  process.env.CDK_CONTEXT_JSON = JSON.stringify(merged);
} else {
  process.env.CDK_CONTEXT_JSON = JSON.stringify(BUNDLING_DISABLED_CONTEXT);
}
