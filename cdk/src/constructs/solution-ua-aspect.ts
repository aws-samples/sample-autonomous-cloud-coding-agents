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

import { IAspect } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { IConstruct } from 'constructs';

/** ABCA solution-attribution id (#319). Mirrors the deploy-time token in
 *  `main.ts` and the per-surface `ua` helpers. */
export const SOLUTION_ID = 'uksb-wt64nei4u6';

/** Documented app-id value cap. Over-limit only warns (never truncates), but
 *  we clip defensively so a long stack name can't produce a noisy log. */
const APP_ID_MAX_LEN = 50;

/** UA-token charset; `#` is the scheme separator, so it is excluded here. */
const UA_TOKEN_UNSAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/g;

/**
 * Build the `AWS_SDK_UA_APP_ID` value for a deployment.
 *
 * `uksb-wt64nei4u6#{stackName}` — the SDK reads this env var natively and
 * renders `app/uksb-wt64nei4u6#{stackName}` on every request, so no client
 * code is involved. CloudFormation stack names are `[A-Za-z0-9-]` (already a
 * subset of the app-id charset), but a non-CFN override value is sanitized
 * defensively. Clipped to the documented 50-char value cap.
 *
 * Returns `undefined` for an explicit empty override — the caller then omits
 * the env var entirely, which is the customer opt-out (no `app/` segment).
 */
export function buildAppId(stackName: string, override?: string): string | undefined {
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed === '' ? undefined : trimmed.replace(UA_TOKEN_UNSAFE, '-').slice(0, APP_ID_MAX_LEN);
  }
  const value = `${SOLUTION_ID}#${stackName.replace(UA_TOKEN_UNSAFE, '-')}`;
  return value.slice(0, APP_ID_MAX_LEN);
}

/**
 * Aspect that sets `AWS_SDK_UA_APP_ID` on every Lambda function in scope so
 * the SDK-native `app/` solution-attribution segment rides every outbound AWS
 * API call — current and future functions alike, without per-function wiring
 * (the structural guarantee a hand-threaded env var can't make). The
 * per-surface `ABCA_COMPONENT` (the `md/` label) is still set on each
 * construct's env block; this aspect owns only the universal app-id.
 *
 * Applied once at the stack level. A `undefined` appId (empty override) makes
 * this a no-op, so the customer opt-out leaves no `app/` segment anywhere.
 */
export class SolutionUaAspect implements IAspect {
  public constructor(private readonly appId: string | undefined) {}

  public visit(node: IConstruct): void {
    if (this.appId === undefined) {
      return;
    }
    if (node instanceof lambda.Function) {
      node.addEnvironment('AWS_SDK_UA_APP_ID', this.appId);
    }
  }
}

/**
 * Aspect that sets `ABCA_COMPONENT` (the `md/` solution-attribution label) on
 * every Lambda function in scope. Applied at a construct scope so all of an
 * integration's functions share one component label (`webhook`, …) without
 * hand-editing each function's `environment` block — and any future function
 * added to that construct is covered automatically.
 *
 * Apply this only to scopes whose functions all share the one label; surfaces
 * that set `ABCA_COMPONENT` directly in their env block (task-api `api`,
 * orchestrator/reconcilers `orchestr`) do not use this aspect.
 */
export class ComponentUaAspect implements IAspect {
  public constructor(private readonly component: string) {}

  public visit(node: IConstruct): void {
    if (node instanceof lambda.Function) {
      node.addEnvironment('ABCA_COMPONENT', this.component);
    }
  }
}
