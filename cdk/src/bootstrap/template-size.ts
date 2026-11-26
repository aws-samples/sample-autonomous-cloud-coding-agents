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

import { execFileSync } from 'node:child_process';

import * as yaml from 'js-yaml';

/**
 * `LARGE_TEMPLATE_SIZE_KB * 1024` in the CDK CLI — the ceiling above which a
 * template must come from S3 rather than inline `TemplateBody`.
 */
const LARGE_TEMPLATE_SIZE_KB = 50;
export const CFN_INLINE_TEMPLATE_LIMIT = LARGE_TEMPLATE_SIZE_KB * 1024;

/**
 * Where the generator fails, deliberately below {@link CFN_INLINE_TEMPLATE_LIMIT}.
 */
export const TEMPLATE_SIZE_BUDGET = 49_152;

const STDOUT_BUFFER_MIB = 32;
const STDOUT_BUFFER_BYTES = STDOUT_BUFFER_MIB * 1024 * 1024;

/**
 * Ask the CDK CLI itself how large the body will be.
 *
 * `cdk bootstrap --show-template` runs the same `toYAML` path as the real bootstrap, so
 * this measures the CLI's own output rather than a local reimplementation of it.
 *
 * Needs no AWS credentials and no network: `--show-template` only renders.
 */
export function cloudFormationBodySize(templatePath: string, cwd: string): number {
  let stdout: string;
  try {
    stdout = execFileSync(
      'npx',
      [
        'cdk', 'bootstrap', '--show-template',
        // In CI mode the CLI routes progress to *stdout* rather than stderr, so
        // "Using bootstrapping template from <path>" gets counted as part of the body.
        '--no-ci',
        '--no-notices',
        '--template', templatePath,
      ],
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: STDOUT_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    throw new Error(
      `cdk bootstrap --show-template failed for ${templatePath}: ${e.message ?? 'unknown error'}`
      + (stderr ? `\nCLI stderr:\n${stderr}` : ''),
      { cause: err },
    );
  }

  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;

  assertLooksLikeTemplate(body, templatePath);

  // `String.length` (UTF-16 code units), matching the CLI's own
  // `templateJson.length <= LARGE_TEMPLATE_SIZE_KB * 1024`.
  return body.length;
}

function assertLooksLikeTemplate(body: string, templatePath: string): void {
  const parsed = yaml.load(body) as { Resources?: unknown; Parameters?: unknown } | null;
  const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);

  if (!isObject(parsed) || !isObject(parsed?.Resources) || !isObject(parsed?.Parameters)) {
    throw new Error(
      `cdk bootstrap --show-template did not return a CloudFormation template for ${templatePath}`
      + ` (${body.length} chars, Resources/Parameters missing or not objects).`
      + ' Measuring this would report a meaningless size.',
    );
  }
}

export interface BudgetVerdict {
  readonly withinBudget: boolean;
  readonly overBudgetBy: number;
  readonly overHardLimit: boolean;
}

/**
 * Compare a measured body size against the budget and the hard ceiling.
 */
export function checkTemplateBudget(bodySize: number): BudgetVerdict {
  return {
    withinBudget: bodySize <= TEMPLATE_SIZE_BUDGET,
    overBudgetBy: Math.max(0, bodySize - TEMPLATE_SIZE_BUDGET),
    overHardLimit: bodySize > CFN_INLINE_TEMPLATE_LIMIT,
  };
}
