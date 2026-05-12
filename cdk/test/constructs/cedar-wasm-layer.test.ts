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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  CEDAR_WASM_MIN_LAMBDA_MEMORY_MB,
  CEDAR_WASM_VERSION,
  CedarWasmLayer,
} from '../../src/constructs/cedar-wasm-layer';

describe('CedarWasmLayer', () => {
  let template: Template;

  beforeEach(() => {
    const app = new App();
    const stack = new Stack(app, 'TestStack');
    new CedarWasmLayer(stack, 'CedarWasmLayer');
    template = Template.fromStack(stack);
  });

  test('creates a Lambda LayerVersion', () => {
    template.resourceCountIs('AWS::Lambda::LayerVersion', 1);
  });

  test('layer targets Node.js 20 and 22 compatible runtimes', () => {
    template.hasResourceProperties('AWS::Lambda::LayerVersion', {
      CompatibleRuntimes: ['nodejs20.x', 'nodejs22.x', 'nodejs24.x'],
    });
  });

  test('description identifies the pinned cedar-wasm version and design reference', () => {
    // Operators running ``aws lambda get-layer-version`` see which wasm
    // engine version ships with the stack. Tying the default description
    // to the constant means bumping the version updates the description
    // automatically.
    const layers = template.findResources('AWS::Lambda::LayerVersion');
    const layerProps = Object.values(layers)[0].Properties;
    expect(layerProps.Description).toContain(CEDAR_WASM_VERSION);
  });

  test('CEDAR_WASM_VERSION matches the cdk/package.json pin', () => {
    // Drift guard: if the top-level package.json entry moves but the
    // layer constant does not, the CI parity test catches it only on
    // the wasm-vs-cedarpy axis, not on the two-wasm-sources axis. A
    // direct assertion here kills the drift at build time.
    const cdkPkg = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'package.json'),
        'utf-8',
      ),
    );
    expect(cdkPkg.dependencies['@cedar-policy/cedar-wasm']).toBe(CEDAR_WASM_VERSION);
  });

  test('CEDAR_WASM_VERSION matches the layer manifest package.json', () => {
    const layerPkg = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', '..', 'layers', 'cedar-wasm', 'package.json'),
        'utf-8',
      ),
    );
    expect(layerPkg.dependencies['@cedar-policy/cedar-wasm']).toBe(CEDAR_WASM_VERSION);
  });

  test('exposes the minimum Lambda memory requirement', () => {
    // The Cedar-wasm engine needs ≥512 MB headroom. Callers wiring a
    // Lambda should assert
    // ``fn.memorySize >= CEDAR_WASM_MIN_LAMBDA_MEMORY_MB``; pinning
    // the constant here makes that check a one-liner.
    expect(CEDAR_WASM_MIN_LAMBDA_MEMORY_MB).toBeGreaterThanOrEqual(512);
  });

  test('custom description is respected when provided', () => {
    const app = new App();
    const stack = new Stack(app, 'CustomDescStack');
    new CedarWasmLayer(stack, 'CedarWasmLayer', {
      description: 'custom layer description for tests',
    });
    const customTemplate = Template.fromStack(stack);
    customTemplate.hasResourceProperties('AWS::Lambda::LayerVersion', {
      Description: 'custom layer description for tests',
    });
  });

  test('exposes the underlying LayerVersion as .layer', () => {
    const app = new App();
    const stack = new Stack(app, 'ExposeStack');
    const layer = new CedarWasmLayer(stack, 'CedarWasmLayer');
    // The .layer property is how agent.ts attaches the layer onto
    // specific functions (ApproveTaskFn / DenyTaskFn / etc.); it
    // must be a real LayerVersion.
    expect(layer.layer).toBeDefined();
    expect(layer.layer.layerVersionArn).toBeDefined();
  });
});
