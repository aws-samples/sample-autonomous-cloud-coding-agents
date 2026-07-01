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

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { CliError } from './errors';
import { loadActiveRepoConfig } from './repo-lookup';
import { getStackOutput } from './stack-outputs';

export type GithubTokenSecretSource = 'explicit' | 'blueprint' | 'platform';

export interface ResolvedGithubTokenSecret {
  readonly secretArn: string;
  readonly source: GithubTokenSecretSource;
  /** Set when --repo was used but the blueprint has no per-repo secret override. */
  readonly repoUsesPlatformDefault?: boolean;
}

export interface ResolveGithubTokenSecretOptions {
  readonly region: string;
  readonly stackName: string;
  readonly repo?: string;
  readonly secretArn?: string;
}

/**
 * Resolve which Secrets Manager secret should receive a GitHub PAT.
 *
 * - No flags → platform default (`GitHubTokenSecretArn` stack output).
 * - `--secret-arn` → explicit ARN (for scripting / secrets created outside CDK).
 * - `--repo owner/repo` → blueprint override when `credentials.githubTokenSecretArn`
 *   was wired in CDK; otherwise falls back to the platform default with a notice.
 */
export async function resolveGithubTokenSecretArn(
  options: ResolveGithubTokenSecretOptions,
): Promise<ResolvedGithubTokenSecret> {
  if (options.secretArn && options.repo) {
    throw new CliError('Use either --repo or --secret-arn, not both.');
  }

  if (options.secretArn) {
    return { secretArn: options.secretArn, source: 'explicit' };
  }

  const platformSecretArn = await getStackOutput(
    options.region,
    options.stackName,
    'GitHubTokenSecretArn',
  );
  if (!platformSecretArn) {
    throw new CliError(
      `Stack '${options.stackName}' is missing output 'GitHubTokenSecretArn'. `
      + 'Re-deploy the CDK stack (mise //cdk:deploy).',
    );
  }

  if (!options.repo) {
    return { secretArn: platformSecretArn, source: 'platform' };
  }

  const repoTableName = await getStackOutput(options.region, options.stackName, 'RepoTableName');
  if (!repoTableName) {
    throw new CliError(
      `Stack '${options.stackName}' is missing output 'RepoTableName'. `
      + 'Re-deploy the CDK stack (mise //cdk:deploy).',
    );
  }

  const repoConfig = await loadActiveRepoConfig(options.region, repoTableName, options.repo);
  if (repoConfig.github_token_secret_arn) {
    return {
      secretArn: repoConfig.github_token_secret_arn,
      source: 'blueprint',
    };
  }

  return {
    secretArn: platformSecretArn,
    source: 'platform',
    repoUsesPlatformDefault: true,
  };
}

/** True when the secret already holds a non-placeholder PAT/token string. */
export async function isGithubTokenConfigured(
  region: string,
  secretArn: string,
): Promise<boolean> {
  const sm = new SecretsManagerClient({ region });
  try {
    const cur = await sm.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!cur.SecretString || cur.SecretString.length === 0) {
      return false;
    }
    // CDK seeds an empty JSON placeholder on first deploy; a real PAT would not.
    if (cur.SecretString.startsWith('{')) {
      return false;
    }
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === 'ResourceNotFoundException') {
      return false;
    }
    throw err;
  }
}

/** Store a GitHub PAT in Secrets Manager. */
export async function putGithubToken(
  region: string,
  secretArn: string,
  token: string,
): Promise<void> {
  const sm = new SecretsManagerClient({ region });
  await sm.send(new PutSecretValueCommand({
    SecretId: secretArn,
    SecretString: token,
  }));
}
