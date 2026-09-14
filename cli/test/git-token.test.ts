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

import { validateGitToken } from '../src/git-token';

describe('validateGitToken', () => {
  describe('empty tokens', () => {
    test('rejects empty string for github', () => {
      const result = validateGitToken('', 'github');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('empty');
    });

    test('rejects empty string for bitbucket', () => {
      const result = validateGitToken('', 'bitbucket');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('empty');
    });

    test('rejects whitespace-only string', () => {
      const result = validateGitToken('   ', 'github');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('empty');
    });
  });

  describe('github tokens', () => {
    test('accepts ghp_ prefixed token', () => {
      expect(validateGitToken('ghp_abc123', 'github').valid).toBe(true);
    });

    test('accepts gho_ prefixed token', () => {
      expect(validateGitToken('gho_abc123', 'github').valid).toBe(true);
    });

    test('accepts ghs_ prefixed token', () => {
      expect(validateGitToken('ghs_abc123', 'github').valid).toBe(true);
    });

    test('accepts ghu_ prefixed token', () => {
      expect(validateGitToken('ghu_abc123', 'github').valid).toBe(true);
    });

    test('accepts ghr_ prefixed token', () => {
      expect(validateGitToken('ghr_abc123', 'github').valid).toBe(true);
    });

    test('accepts github_pat_ prefixed token', () => {
      expect(validateGitToken('github_pat_abc123', 'github').valid).toBe(true);
    });

    test('rejects token without valid github prefix', () => {
      const result = validateGitToken('some-random-token', 'github');
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('ghp_');
    });
  });

  describe('bitbucket tokens', () => {
    test('accepts any non-empty string for bitbucket', () => {
      expect(validateGitToken('some-opaque-token', 'bitbucket').valid).toBe(true);
    });

    test('accepts token that looks like github token for bitbucket', () => {
      expect(validateGitToken('ghp_abc123', 'bitbucket').valid).toBe(true);
    });

    test('accepts random string for bitbucket', () => {
      expect(validateGitToken('ATBBxyz123456', 'bitbucket').valid).toBe(true);
    });
  });
});
