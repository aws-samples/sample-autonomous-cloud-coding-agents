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

import { CfnResource, IAspect } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { IConstruct } from 'constructs';

const SOLUTION_ID = 'uksb-wt64nei4u6';

// The AWS SDK's documented cap on an app-id value; a longer one only logs a warning.
const APP_ID_MAX_LEN = 50;

const UA_TOKEN_UNSAFE = /[^A-Za-z0-9!$%&'*+\-.^_`|~]/g;

function sanitizeAppId(value: string): string {
  return value
    .split('#')
    .map((segment) => segment.replace(UA_TOKEN_UNSAFE, '-'))
    .join('#');
}

function clipAppId(value: string): string {
  const clipped = value.slice(0, APP_ID_MAX_LEN);
  return clipped.endsWith('#') ? clipped.slice(0, -1) : clipped;
}

/**
 * Build the `AWS_SDK_UA_APP_ID` value for a deployment:
 * `uksb-wt64nei4u6#{stackName}`, or the sanitized `override`, clipped to 50
 * characters. The SDK reads this env var natively and renders it as the
 * `app/` segment of every request.
 *
 * Returns `undefined` for an explicit empty override — the caller then omits
 * the env var entirely, which is the customer opt-out (no `app/` segment).
 */
export function buildAppId(stackName: string, override?: string): string | undefined {
  if (override !== undefined) {
    const trimmed = override.trim();
    return trimmed === '' ? undefined : clipAppId(sanitizeAppId(trimmed));
  }
  const value = `${SOLUTION_ID}#${stackName.replace(UA_TOKEN_UNSAFE, '-')}`;
  return clipAppId(value);
}

/**
 * Aspect that sets `AWS_SDK_UA_APP_ID` on every Lambda function in scope.
 * An `undefined` appId makes it a no-op.
 */
export class SolutionUaAspect implements IAspect {
  public constructor(private readonly appId: string | undefined) {}

  public visit(node: IConstruct): void {
    if (this.appId === undefined) {
      return;
    }
    if (node instanceof lambda.Function) {
      node.addEnvironment('AWS_SDK_UA_APP_ID', this.appId);
    } else if (CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::Lambda::Function'
      && !(node.node.scope instanceof lambda.Function)) {
      // Core CDK providers (e.g. default-SG restriction and S3 auto-delete) use
      // generic CfnResource directly, bypassing the L2 environment API above.
      node.addPropertyOverride('Environment.Variables.AWS_SDK_UA_APP_ID', this.appId);
    }
  }
}

/**
 * Aspect that sets `ABCA_COMPONENT` (the `md/` solution-attribution label) on
 * every Lambda function in scope. Apply it only to scopes whose functions all
 * share the one label.
 */
export class ComponentUaAspect implements IAspect {
  public constructor(private readonly component: string) {}

  public visit(node: IConstruct): void {
    if (node instanceof lambda.Function) {
      node.addEnvironment('ABCA_COMPONENT', this.component);
    }
  }
}
