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

import { tryLoadConfig } from './config';
import { resolveOperatorRegion } from './stack-outputs';

export const DEFAULT_STACK_NAME = 'backgroundagent-dev';

/** Shared operator CLI flags resolved against optional bgagent configure state. */
export function resolveOperatorContext(opts: {
  region?: string;
  stackName?: string;
}): { region: string; stackName: string } {
  const config = tryLoadConfig();
  return {
    region: resolveOperatorRegion(opts, config?.region),
    stackName: opts.stackName ?? DEFAULT_STACK_NAME,
  };
}

/** Redact a Secrets Manager ARN for display (keep random suffix for disambiguation). */
export function redactSecretArn(arn: string): string {
  const parts = arn.split(':');
  const SECRET_ARN_MIN_PARTS = 7;
  const SECRET_RESOURCE_INDEX = 5;
  const SECRET_NAME_INDEX = 6;
  if (parts.length < SECRET_ARN_MIN_PARTS || parts[SECRET_RESOURCE_INDEX] !== 'secret') {
    return '****';
  }
  const secretPart = parts[SECRET_NAME_INDEX];
  const dash = secretPart.lastIndexOf('-');
  if (dash <= 0) {
    return `${parts.slice(0, SECRET_NAME_INDEX).join(':')}:****`;
  }
  const suffix = secretPart.slice(dash);
  return `${parts.slice(0, SECRET_NAME_INDEX).join(':')}:****${suffix}`;
}
