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
 * Provider-agnostic git token management.
 * Wraps the existing GitHub token functions and adds Bitbucket support.
 */

import type { GitProviderType } from './types';

export { resolveGithubTokenSecretArn, putGithubToken, isGithubTokenConfigured } from './github-token';

/**
 * Validate a git token for the given provider.
 * GitHub tokens must start with known prefixes; Bitbucket tokens are opaque strings.
 */
export function validateGitToken(token: string, provider: GitProviderType): { valid: boolean; reason?: string } {
  if (!token || token.trim().length === 0) {
    return { valid: false, reason: 'Token is empty' };
  }
  if (provider === 'github') {
    const validPrefixes = ['ghp_', 'gho_', 'ghs_', 'ghu_', 'ghr_', 'github_pat_'];
    const hasValidPrefix = validPrefixes.some(p => token.startsWith(p));
    if (!hasValidPrefix) {
      return { valid: false, reason: 'GitHub token must start with ghp_, gho_, ghs_, ghu_, ghr_, or github_pat_' };
    }
  }
  // Bitbucket access tokens are opaque — no prefix validation
  return { valid: true };
}
