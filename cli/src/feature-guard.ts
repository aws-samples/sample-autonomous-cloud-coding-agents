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

import { Command } from 'commander';
import { tryLoadConfig } from './config';
import { debug } from './debug';
import {
  DEPLOYMENT_FEATURES_OUTPUT,
  DeploymentFeature,
  featureNotDeployedError,
  publishedFeatureNames,
} from './deployment-profile';
import { getStackOutput } from './stack-outputs';

/**
 * Fail an operator subcommand early when its stack omits the module it manages
 * (ADR-024). The stack is `--stack-name`, else the one the CLI was configured
 * from. Only the authoritative `DeploymentFeatures` output can prove a feature
 * absent: stacks that predate it, an unknown stack and unreadable stacks fall
 * through to the command's own handling.
 */
export function requireDeployedFeature(command: Command, feature: DeploymentFeature): Command {
  return command.hook('preAction', async (_parent, action) => {
    const opts = action.opts() as { region?: string; stackName?: string };
    const config = tryLoadConfig();
    const stackName = opts.stackName ?? config?.stack_name;
    if (!stackName) return;
    const region = opts.region ?? config?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
    if (!region) return;
    let published: string | null;
    try {
      published = await getStackOutput(region, stackName, DEPLOYMENT_FEATURES_OUTPUT);
    } catch (err) {
      debug(`[feature-guard] skipping ${feature} check: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    // Lenient: a newer stack may publish features this CLI does not know.
    if (published !== null && !publishedFeatureNames(published).includes(feature)) {
      throw featureNotDeployedError(feature, stackName);
    }
  });
}
