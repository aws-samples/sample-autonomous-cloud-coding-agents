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
 * How large the bootstrap template is *as CloudFormation receives it* (#864).
 *
 * The on-disk size of `bootstrap/bootstrap-template.yaml` is not that quantity and
 * cannot stand in for it. `cdk bootstrap --template <file>` parses the file and
 * discards its formatting, then re-serialises the parsed object with the CLI's own
 * YAML writer before deciding whether the result fits inline:
 *
 * ```js
 * // aws-cdk/lib/index.js — makeBodyParameter()
 * const templateJson = toYAML(overrideTemplate ?? stack.template);
 * if (templateJson.length <= LARGE_TEMPLATE_SIZE_KB * 1024) return { TemplateBody: templateJson };
 * const toolkitInfo = await resources.lookupToolkit();   // ← needs a bootstrap bucket
 * ```
 *
 * Past the limit the CLI must stage the template in S3, which it cannot do while
 * bootstrapping a fresh account — that bucket is one of the resources bootstrap
 * creates. The result is `BootstrapStackRequired`, with no way through
 * `cdk bootstrap` at all, `--force` included.
 *
 * So both the generator's guard and the artifact's regression test measure
 * {@link cloudFormationBodySize}, never bytes on disk.
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
 *
 * The margin is the point: a policy addition should fail in the generator, where the
 * content is produced and the author can act on it, rather than surfacing later as an
 * opaque CDK CLI error against somebody's fresh account.
 */
export const TEMPLATE_SIZE_BUDGET = 49_152;

/** Ceiling for the rendered template captured from the CLI, well clear of any plausible
 *  template size so a growing artifact fails the budget check rather than truncating
 *  into a falsely-passing measurement. */
const STDOUT_BUFFER_MIB = 32;
const STDOUT_BUFFER_BYTES = STDOUT_BUFFER_MIB * 1024 * 1024;

/**
 * Ask the CDK CLI itself how large the body will be.
 *
 * `cdk bootstrap --show-template` runs the same `toYAML` path as the real bootstrap, so
 * this measures the CLI's own output rather than a local reimplementation of it. That
 * matters more than it might seem: the CLI serialises with `yaml@1` and a patched fold
 * width, which it bundles internally and does not export. Mirroring that would mean
 * taking a direct dependency on `yaml` — currently present only as a transitive
 * `resolutions` pin — and would silently drift the day the CLI changes writer or
 * options. Shelling out to the tool that makes the decision cannot drift.
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
        // `--no-ci` is load-bearing, not tidiness. In CI mode the CLI routes progress to
        // *stdout* rather than stderr, so "Using bootstrapping template from <path>" gets
        // counted as part of the body: 45,744 locally versus 45,812 with `CI=true`, and
        // the delta tracks the path's length. `.github/workflows/build.yml` sets
        // `CI: true`, so without this the measurement is inflated by a console line and
        // varies with where the template happens to live.
        '--no-ci',
        // Notices are another stdout writer, and they hit the network.
        '--no-notices',
        '--template', templatePath,
      ],
      {
        cwd,
        encoding: 'utf-8',
        maxBuffer: STDOUT_BUFFER_BYTES,
        // Capture stderr rather than discarding it: without this a non-zero exit
        // surfaces only as "Command failed", with the CLI's own explanation thrown away.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = e.stderr ? String(e.stderr).trim() : '';
    throw new Error(
      `cdk bootstrap --show-template failed for ${templatePath}: ${e.message ?? 'unknown error'}`
      + (stderr ? `\nCLI stderr:\n${stderr}` : ''),
    );
  }

  // The CLI prints the body followed by a newline. The gate is on the body, so drop
  // exactly one trailing newline if present rather than counting the console artefact.
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;

  assertLooksLikeTemplate(body, templatePath);

  // `String.length` (UTF-16 code units), matching the CLI's own
  // `templateJson.length <= LARGE_TEMPLATE_SIZE_KB * 1024`. Not `Buffer.byteLength`:
  // code units are what the gate compares, so counting UTF-8 bytes would diverge from
  // the real decision the moment a non-ASCII character entered a policy.
  return body.length;
}

/**
 * Refuse to report a size for something that is not a CloudFormation template.
 *
 * Without this the guard is satisfied by nonsense: an empty input renders as the string
 * `null`, which measures 5 characters and sails under any budget. A guard that passes
 * loudest when it has measured nothing is worse than no guard.
 */
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

/** Outcome of the budget check, so the caller owns the failure message and the pure
 *  decision can be unit-tested without invoking the CLI. */
export interface BudgetVerdict {
  readonly withinBudget: boolean;
  readonly overBudgetBy: number;
  readonly overHardLimit: boolean;
}

/**
 * Compare a measured body size against the budget and the hard ceiling.
 *
 * Split out from the generator so the three interesting points — at budget, one over,
 * and past the inline limit — are testable without shelling out to the CDK CLI. The
 * guard previously had no test at all; the only way to exercise it was to make the real
 * template too big.
 */
export function checkTemplateBudget(bodySize: number): BudgetVerdict {
  return {
    withinBudget: bodySize <= TEMPLATE_SIZE_BUDGET,
    overBudgetBy: Math.max(0, bodySize - TEMPLATE_SIZE_BUDGET),
    overHardLimit: bodySize > CFN_INLINE_TEMPLATE_LIMIT,
  };
}
