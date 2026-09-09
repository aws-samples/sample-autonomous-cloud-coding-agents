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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveCognitoAdminContext } from '../../src/cognito-admin';
import { decodeBundle, encodeBundle, generateTempPassword, makeAdminCommand } from '../../src/commands/admin';
import { CliError } from '../../src/errors';
import { CliConfig } from '../../src/types';

// Mock the Cognito admin layer so `invite-user` resolves a fixed context and
// performs no AWS calls — the assertion is on the local credentials file the
// command writes, not on Cognito.
jest.mock('../../src/cognito-admin', () => ({
  ...jest.requireActual('../../src/cognito-admin'),
  resolveCognitoAdminContext: jest.fn().mockResolvedValue({
    region: 'us-east-1',
    userPoolId: 'us-east-1_abc',
    configureBundle: null,
  }),
  adminInviteUser: jest.fn().mockResolvedValue(undefined),
}));

describe('admin bundle helpers', () => {
  const sampleConfig: CliConfig = {
    api_url: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1',
    region: 'us-east-1',
    user_pool_id: 'us-east-1_AbCdEfGhI',
    client_id: '1a2b3c4d5e6f7g8h9i0j1k2l3m',
  };

  test('encode → decode round-trips a config', () => {
    const bundle = encodeBundle(sampleConfig);
    const decoded = decodeBundle(bundle);
    expect(decoded).toEqual(sampleConfig);
  });

  test('encoded bundle is plain base64 (no whitespace, no padding mangling)', () => {
    const bundle = encodeBundle(sampleConfig);
    expect(bundle).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test('decode trims surrounding whitespace from a pasted bundle', () => {
    const bundle = encodeBundle(sampleConfig);
    expect(decodeBundle(`  ${bundle}  \n`)).toEqual(sampleConfig);
  });

  test('decode rejects non-base64 input', () => {
    expect(() => decodeBundle('not base64 !!!')).toThrow(CliError);
  });

  test('decode rejects base64 that does not contain JSON', () => {
    const bogus = Buffer.from('not json at all', 'utf-8').toString('base64');
    expect(() => decodeBundle(bogus)).toThrow(/not JSON/);
  });

  test('decode rejects bundle missing required fields', () => {
    const partial = Buffer.from(JSON.stringify({ api_url: 'x', region: 'y' })).toString('base64');
    expect(() => decodeBundle(partial)).toThrow(/missing or empty fields user_pool_id, client_id/);
  });

  test('decode rejects bundle with empty-string fields', () => {
    const empty = Buffer.from(JSON.stringify({
      api_url: '',
      region: 'us-east-1',
      user_pool_id: 'pool',
      client_id: 'client',
    })).toString('base64');
    expect(() => decodeBundle(empty)).toThrow(/missing or empty fields api_url/);
  });
});

describe('generateTempPassword', () => {
  // Cognito's default policy: min 12 chars, with at least one upper, lower,
  // digit, and symbol. The CLI relies on satisfying this by construction —
  // these tests guard against a regression that would silently produce
  // passwords Cognito rejects with "InvalidPasswordException" only at
  // `admin-create-user` time.
  const upper = /[A-Z]/;
  const lower = /[a-z]/;
  const digit = /[0-9]/;
  const symbol = /[!@#$%^&*()\-_=+\[\]{}<>?]/;

  test('produces a password ≥ 18 chars', () => {
    const pwd = generateTempPassword();
    expect(pwd.length).toBeGreaterThanOrEqual(18);
  });

  test('contains at least one upper, lower, digit, and symbol', () => {
    // Sample many passwords — the random shuffle should never strip a class.
    for (let i = 0; i < 50; i += 1) {
      const pwd = generateTempPassword();
      expect(pwd).toMatch(upper);
      expect(pwd).toMatch(lower);
      expect(pwd).toMatch(digit);
      expect(pwd).toMatch(symbol);
    }
  });

  test('produces distinct passwords on repeated calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      seen.add(generateTempPassword());
    }
    // Allow at most one collision in 20 draws (effectively 0 with crypto rand).
    expect(seen.size).toBeGreaterThanOrEqual(19);
  });
});

describe('admin invite-user credentials file', () => {
  let tmpDir: string;
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bgagent-invite-test-'));
    process.env.BGAGENT_CONFIG_DIR = tmpDir;
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    delete process.env.BGAGENT_CONFIG_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    consoleSpy.mockRestore();
  });

  test('writes an aligned block with the temp-password label and first-login note', async () => {
    const admin = makeAdminCommand();
    await admin.parseAsync([
      'node', 'admin',
      'invite-user', 'teammate@example.com',
      '--password', 'K9$mPq2nL!vXf3Hb',
    ]);

    const invitePath = path.join(tmpDir, 'invites', 'teammate@example.com.txt');
    const body = fs.readFileSync(invitePath, 'utf-8');
    const lines = body.split('\n');

    // The label is "temp password:" (not "password:") for invites.
    const emailLine = lines.find((l) => l.startsWith('email:'))!;
    const pwdLine = lines.find((l) => l.startsWith('temp password:'))!;
    expect(pwdLine).toContain('K9$mPq2nL!vXf3Hb');
    expect(lines.some((l) => l.startsWith('password:'))).toBe(false);

    // All labels pad to the widest ("temp password:" = 14), so the value column
    // lines up: every value begins at offset 15 (label width + one space).
    const VALUE_COLUMN = 'temp password:'.length + 1;
    expect(emailLine.indexOf('teammate@example.com')).toBe(VALUE_COLUMN);
    expect(pwdLine.indexOf('K9$mPq2nL!vXf3Hb')).toBe(VALUE_COLUMN);

    // The trailing first-login guidance the docs promise.
    expect(body).toContain('On first login you will be prompted to set a permanent password.');
  });

  test('the bundle label pads to the same value column as the others', async () => {
    // The bundle line is the one rendered in USER_GUIDE.md's sample, and it is
    // padded independently of email/temp-password — so un-padding ONLY that
    // label would otherwise keep the suite green.
    const bundleConfig: CliConfig = {
      api_url: 'https://abc123.execute-api.us-east-1.amazonaws.com/v1',
      region: 'us-east-1',
      user_pool_id: 'us-east-1_AbCdEfGhI',
      client_id: '1a2b3c4d5e6f7g8h9i0j1k2l3m',
    };
    jest.mocked(resolveCognitoAdminContext).mockResolvedValueOnce({
      region: 'us-east-1',
      userPoolId: 'us-east-1_abc',
      configureBundle: bundleConfig,
    } as Awaited<ReturnType<typeof resolveCognitoAdminContext>>);

    const admin = makeAdminCommand();
    await admin.parseAsync([
      'node', 'admin',
      'invite-user', 'teammate@example.com',
      '--password', 'K9$mPq2nL!vXf3Hb',
    ]);

    const invitePath = path.join(tmpDir, 'invites', 'teammate@example.com.txt');
    const lines = fs.readFileSync(invitePath, 'utf-8').split('\n');
    const bundleLine = lines.find((l) => l.startsWith('bundle:'));
    expect(bundleLine).toBeDefined();
    expect(bundleLine!.indexOf(encodeBundle(bundleConfig))).toBe('temp password:'.length + 1);
  });
});
