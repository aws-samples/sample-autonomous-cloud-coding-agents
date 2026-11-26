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

// `aws:cdk:bundling-stacks: []` makes synth bundle no stacks (#366). CDK reads
// CDK_CONTEXT_JSON when an `App` is constructed. `App.loadContext` applies
// `props.context`, then CDK_CONTEXT_JSON, then `postCliContext`, so only
// `postCliContext: { 'aws:cdk:bundling-stacks': ['**'] }` re-enables bundling.
const BUNDLING_DISABLED_CONTEXT = { 'aws:cdk:bundling-stacks': [] as string[] };

const existing = process.env.CDK_CONTEXT_JSON;
if (existing) {
  let ambient: Record<string, unknown>;
  try {
    ambient = JSON.parse(existing);
  } catch {
    throw new Error(`malformed CDK_CONTEXT_JSON in environment (must be valid JSON): ${existing}`);
  }
  const merged = { ...ambient, ...BUNDLING_DISABLED_CONTEXT };
  process.env.CDK_CONTEXT_JSON = JSON.stringify(merged);
} else {
  process.env.CDK_CONTEXT_JSON = JSON.stringify(BUNDLING_DISABLED_CONTEXT);
}
