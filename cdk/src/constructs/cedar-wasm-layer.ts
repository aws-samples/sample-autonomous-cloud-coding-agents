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

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DockerImage } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Pinned Cedar-wasm version — kept in sync with the top-level
 * ``cdk/package.json`` entry. Mismatch would let the agent-side
 * ``cedarpy`` engine and the Lambda-side ``cedar-wasm`` engine drift,
 * defeating the parity contract (design decision #23, §15.6).
 *
 * Reading this from a constant (rather than the caller passing it)
 * lets the tests assert we ship the right version without duplicating
 * the number across files.
 */
export const CEDAR_WASM_VERSION = '4.10.0';

/**
 * Minimum memory the Lambda attaching this layer should be configured
 * with. Cedar-wasm needs ≥512 MB headroom (§15.2 task 10 note); callers
 * wiring this layer onto a Lambda should cross-check their function's
 * memorySize against this constant.
 */
export const CEDAR_WASM_MIN_LAMBDA_MEMORY_MB = 512;

/**
 * Properties for CedarWasmLayer construct.
 */
export interface CedarWasmLayerProps {
  /**
   * Layer description. Defaults to a design-linked description so
   * ``aws lambda get-layer-version`` output is self-documenting.
   */
  readonly description?: string;
}

/**
 * Lambda layer bundling `@cedar-policy/cedar-wasm` for the REST-side
 * policy handlers (Chunk 5: ApproveTaskFn / DenyTaskFn / GetPoliciesFn /
 * CreateTaskFn).
 *
 * Layout produced:
 *
 * ```
 * /opt/nodejs/node_modules/@cedar-policy/cedar-wasm/
 *   nodejs/cedar_wasm.js
 *   nodejs/cedar_wasm_bg.wasm
 *   ... (package.json + d.ts + README)
 * ```
 *
 * Lambdas attaching this layer ``require('@cedar-policy/cedar-wasm/nodejs')``
 * and load the wasm module transparently. The wasm binary is ~4 MB; a
 * shared layer keeps each individual function package small so cold
 * starts stay fast.
 *
 * Bundling uses ``npm install`` against a minimal ``package.json`` that
 * pins the exact ``CEDAR_WASM_VERSION``. The source-side ``cdk/package.json``
 * is the canonical pin; this construct re-declares the version string in
 * a layer-local manifest to keep bundling hermetic (no reliance on yarn
 * workspace resolution).
 *
 * Runtime compatibility is the union of Node.js 20 and 22 — older
 * runtimes lack the subtle WebAssembly support cedar-wasm relies on.
 *
 * See §15.2 task 10 and §15.6.
 */
export class CedarWasmLayer extends Construct {
  /**
   * The underlying Lambda layer. Attach to functions via
   * ``fn.addLayers(cedarWasmLayer.layer)``.
   */
  public readonly layer: lambda.LayerVersion;

  constructor(scope: Construct, id: string, props: CedarWasmLayerProps = {}) {
    super(scope, id);

    // Bundling source: a small directory with a package.json that pins
    // cedar-wasm at CEDAR_WASM_VERSION. The bundling command does
    // `npm install --omit=dev` and lands the result under /opt/nodejs.
    //
    // Using an inline source directory (rather than depending on
    // cdk/package.json being resolved at bundle time) keeps this layer
    // fully hermetic: a stale `cdk/node_modules/` cannot leak into the
    // layer build.
    const layerSourceDir = path.join(__dirname, '..', '..', 'layers', 'cedar-wasm');

    this.layer = new lambda.LayerVersion(this, 'Layer', {
      code: lambda.Code.fromAsset(layerSourceDir, {
        bundling: {
          image: DockerImage.fromRegistry('public.ecr.aws/sam/build-nodejs22.x:latest'),
          command: [
            'bash',
            '-c',
            [
              'cp -r . /asset-output',
              'mkdir -p /asset-output/nodejs',
              'cp /asset-output/package.json /asset-output/nodejs/package.json',
              'cd /asset-output/nodejs && npm install --omit=dev',
              'rm /asset-output/package.json',
            ].join(' && '),
          ],
          // Fall back to a local-npm bundle when Docker is unavailable
          // (e.g. `cdk synth` in CI runners that lack Docker). The
          // local hook mirrors the Docker commands using the host's
          // npm, which is acceptable here because the layer only ships
          // pure JS + a prebuilt wasm binary — no native build step.
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                fs.cpSync(layerSourceDir, outputDir, { recursive: true });
                fs.mkdirSync(path.join(outputDir, 'nodejs'), { recursive: true });
                fs.copyFileSync(
                  path.join(outputDir, 'package.json'),
                  path.join(outputDir, 'nodejs', 'package.json'),
                );
                execSync('npm install --omit=dev', {
                  cwd: path.join(outputDir, 'nodejs'),
                  stdio: 'ignore',
                });
                fs.rmSync(path.join(outputDir, 'package.json'));
                return true;
              } catch {
                return false;
              }
            },
          },
        },
      }),
      compatibleRuntimes: [
        lambda.Runtime.NODEJS_20_X,
        lambda.Runtime.NODEJS_22_X,
        lambda.Runtime.NODEJS_24_X,
      ],
      description:
        props.description
        ?? `@cedar-policy/cedar-wasm@${CEDAR_WASM_VERSION} for Cedar HITL policy Lambdas (§15.2 task 10)`,
    });
  }
}
