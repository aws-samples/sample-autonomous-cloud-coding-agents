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
import * as path from 'path';
import { DENY_REASON_SECRET_NAMES, scanDenyReason } from '../../../src/handlers/shared/deny-reason-scanner';

const scanVectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'contracts', 'secret-scan-vectors.json'), 'utf-8'),
) as { vectors: { input: string; expected: string; note: string }[] };

// Built from fragments: Code Defender and gitleaks flag a contiguous token literal, even in a test.
const FIX_AWS_KEY = 'AK' + 'IAIOSFODNN7EXAMPLE';
const FIX_AWS_ASIA = 'AS' + 'IAY2T4IJABCDEFGHIJ';
const FIX_GITHUB_PAT = 'gh' + 'p_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
const FIX_GITHUB_FINE_GRAINED = 'github' + '_pat_' + 'A'.repeat(82);
const FIX_SLACK_BOT = 'xo' + 'xb-' + '1234567890-abcdefghijklmno';
const FIX_PEM_BEGIN = '-----' + 'BEGIN' + ' RSA PRIVATE KEY' + '-----';
const FIX_PEM_END = '-----' + 'END' + ' RSA PRIVATE KEY' + '-----';
const FIX_PRIVATE_KEY = `${FIX_PEM_BEGIN}\nAAAA\n${FIX_PEM_END}`;
const FIX_GITHUB_APP_TOKEN = 'gh' + 's_' + 'A'.repeat(48);
// A GitHub installation token of the stateless format, ghs_<app id>_<JWT>: three base64url parts,
// which may hold "-" and "_", joined by dots.
const FIX_GITHUB_APP_TOKEN_STATELESS = 'gh' + 's_123456_' + ['eyJ' + 'hbGciOi'.repeat(5), 'eyJ' + 'pYXQi-_'.repeat(40), 's1G-n_'.repeat(30)].join('.');
const FIX_JWT_SIGNED = FIX_GITHUB_APP_TOKEN_STATELESS.slice(('gh' + 's_123456_').length);
const FIX_LIKE_AN_OLDER_TOKEN = 'gh' + 'p_' + 'Zz9'.repeat(12);
const FIX_GITHUB_FINE_GRAINED_SHORT = 'github' + '_pat_' + 'ABCDEFGHIJKLMNOPQRSTUV_' + '1'.repeat(20);
const FIX_AWS_SECRET = 'aB3/'.repeat(9) + 'aB3x';
const FIX_AWS_SECRET_ENDING_IN_SLASH = 'aB3/'.repeat(10);
const FIX_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
const FIX_PASSWORD = 's3cret' + 'P4ss';
const FIX_LETTERS_AND_DIGITS = 'Passw0rd' + '123';
const FIX_CONNECTION_STRING = 'postgres://app' + ':s3cretP4ss' + '@db.internal:5432/app';
const FIX_CONNECTION_STRING_WITH_SLASH = 'postgres://admin' + ':abc/def+ghiJKL' + '@db.internal:5432/app';
const FIX_SMTP_URL = 'smtp://alerts@example.com' + ':s3cretP4ss' + '@smtp.example.com:587';
const FIX_AWS_KEY_PAIR_URL = `s3a://${FIX_AWS_KEY}:${FIX_AWS_SECRET_ENDING_IN_SLASH}@bucket/path`;
const FIX_AWS_KEY_PAIR = `${FIX_AWS_KEY}:${'A1b2'.repeat(10)}`;
const FIX_GIT_URL = 'https://x-access-token' + ':s3cret123' + '@github.com/o/r.git';

describe('scanDenyReason', () => {
  test('passes through clean text unchanged', () => {
    const input = 'use force-with-lease instead; force is too risky';
    expect(scanDenyReason(input)).toBe(input);
  });

  test('redacts AWS access key', () => {
    const out = scanDenyReason(`old key ${FIX_AWS_KEY} leaked`);
    expect(out).not.toContain(FIX_AWS_KEY);
    expect(out).toContain('[REDACTED-AWS_KEY]');
  });

  test('redacts AWS temporary access key (ASIA prefix)', () => {
    const out = scanDenyReason(`${FIX_AWS_ASIA} exposed in logs`);
    expect(out).toContain('[REDACTED-AWS_KEY]');
  });

  test('redacts GitHub classic PAT', () => {
    const out = scanDenyReason(`token is ${FIX_GITHUB_PAT} right?`);
    expect(out).not.toContain(FIX_GITHUB_PAT);
    expect(out).toContain('[REDACTED-GITHUB_TOKEN]');
  });

  test('redacts GitHub fine-grained PAT', () => {
    const out = scanDenyReason(`token: ${FIX_GITHUB_FINE_GRAINED}`);
    expect(out).toContain('[REDACTED-GITHUB_TOKEN]');
  });

  test('redacts inline private key block', () => {
    const out = scanDenyReason(`leaked key:\n${FIX_PRIVATE_KEY}\n(fyi)`);
    expect(out).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(out).toContain('[REDACTED-PRIVATE_KEY]');
    expect(out).toContain('(fyi)');
  });

  test('redacts Slack token', () => {
    const out = scanDenyReason(`bot: ${FIX_SLACK_BOT}`);
    expect(out).toContain('[REDACTED-SLACK_TOKEN]');
    expect(out).not.toContain(FIX_SLACK_BOT);
  });

  test('redacts bearer token after "Bearer "', () => {
    const out = scanDenyReason('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
    expect(out).toContain('[REDACTED-GENERIC_BEARER]');
  });

  test('does NOT false-positive on short base64-ish tokens below the bearer threshold', () => {
    expect(scanDenyReason('hash: abc123')).toBe('hash: abc123');
  });

  test.each([
    ['a GitHub token longer than 36 characters', `token ${FIX_GITHUB_APP_TOKEN}`, 'token [REDACTED-GITHUB_TOKEN]'],
    ['a fine-grained GitHub token shorter than 80 characters', FIX_GITHUB_FINE_GRAINED_SHORT, '[REDACTED-GITHUB_TOKEN]'],
    ['a quoted AWS secret key', `AWS_SECRET_ACCESS_KEY="${FIX_AWS_SECRET}", the old one`, '[REDACTED-AWS_SECRET]", the old one'],
    ['an AWS secret key that ends in "/"', `aws_secret_access_key = ${FIX_AWS_SECRET_ENDING_IN_SLASH}`, '[REDACTED-AWS_SECRET]'],
    ['an AWS secret key in the JSON form', `"SecretAccessKey": "${FIX_AWS_SECRET}"`, '"[REDACTED-AWS_SECRET]"'],
    ['a connection string with a password', `${FIX_CONNECTION_STRING} is down`, '[REDACTED-CONNECTION_STRING] is down'],
    ['a connection string whose password holds a slash', `${FIX_CONNECTION_STRING_WITH_SLASH} is down`, '[REDACTED-CONNECTION_STRING] is down'],
    ['a connection string whose user is an e-mail address', `EMAIL_URL=${FIX_SMTP_URL}`, 'EMAIL_URL=[REDACTED-CONNECTION_STRING]'],
    ['an AWS key pair in a URL, with slashes in the secret', FIX_AWS_KEY_PAIR_URL, '[REDACTED-CONNECTION_STRING]'],
    ['a token in a git remote URL', FIX_GIT_URL, 'https://[REDACTED-GITHUB_URL_TOKEN]github.com/o/r.git'],
    ['a bearer token after "BEARER" in capitals', `Authorization: BEARER ${FIX_JWT}`, 'Authorization: [REDACTED-GENERIC_BEARER]'],
  ])('redacts %s', (_shape, input, expected) => {
    expect(scanDenyReason(input)).toBe(expected);
  });

  test.each([
    ['a session token in the query', `mongodb+srv://${FIX_AWS_KEY_PAIR}@cluster0.example.net/app?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:${'T0ken'.repeat(8)}`],
    ['a password in the query', `https://${FIX_AWS_KEY_PAIR}@files.example.com/get?pass` + 'word=Pa55w0rdQuery'],
    ['a password longer than a secret key', `postgres://${FIX_AWS_KEY_PAIR}-TailOfPassword@db.internal/app`],
    ['an SES SMTP password of 44 characters with slashes', `smtp://${FIX_AWS_KEY}:${'aB3/'.repeat(11)}@email-smtp.us-east-1.amazonaws.com:587`],
    ['a session token after the secret key (MC_HOST of the MinIO client)', `https://${FIX_AWS_KEY_PAIR}:${'aB3/'.repeat(150)}@s3.amazonaws.com`],
  ])('replaces a URL whose user is an AWS key id as a whole, with %s', (_what, url) => {
    expect(scanDenyReason(url)).toBe('[REDACTED-CONNECTION_STRING]');
  });

  test('does not take a longer run after an AWS key id for its secret', () => {
    // A secret access key has exactly 40 characters.
    const input =`${FIX_AWS_KEY}:${'a'.repeat(41)}`;
    expect(scanDenyReason(input)).toBe(`[REDACTED-AWS_KEY]:${'a'.repeat(41)}`);
  });

  test('redacts a long GitHub App token in a git remote URL', () => {
    // GitHub installation tokens are about 520 characters since 2026 and vary in length.
    const token = 'ghs_123456_' + Array(3).fill('eyJ' + 'a'.repeat(200)).join('.');
    expect(scanDenyReason(`x-access-token:${token}@github.com/o/r.git`)).toBe('[REDACTED-GITHUB_URL_TOKEN]github.com/o/r.git');
  });

  test.each([
    ['an assignment', `GITHUB_TOKEN=${FIX_GITHUB_APP_TOKEN_STATELESS}`, 'GITHUB_TOKEN=[REDACTED-GITHUB_APP_TOKEN]'],
    ['the bare token', FIX_GITHUB_APP_TOKEN_STATELESS, '[REDACTED-GITHUB_APP_TOKEN]'],
    [
      'a JSON value',
      `{"token": "${FIX_GITHUB_APP_TOKEN_STATELESS}", "expires_at": "2026-11-17T12:00:00Z"}`,
      '{"token": "[REDACTED-GITHUB_APP_TOKEN]", "expires_at": "2026-11-17T12:00:00Z"}',
    ],
    ['an Authorization: token header', `Authorization: token ${FIX_GITHUB_APP_TOKEN_STATELESS}`, 'Authorization: token [REDACTED-GITHUB_APP_TOKEN]'],
  ])('redacts a stateless GitHub App installation token in %s', (_form, input, expected) => {
    expect(scanDenyReason(input)).toBe(expected);
  });

  test.each([
    ['a run in the signature that looks like an older token', `${FIX_GITHUB_APP_TOKEN_STATELESS}${FIX_LIKE_AN_OLDER_TOKEN}-${'s1G-n_'.repeat(10)}`, ''],
    [
      'two such runs, the second like an AWS key id',
      `${FIX_GITHUB_APP_TOKEN_STATELESS}${FIX_LIKE_AN_OLDER_TOKEN}-${FIX_AWS_KEY}-${'s1G-n_'.repeat(10)}`,
      '',
    ],
    ['a bracket behind the token that is no marker', FIX_GITHUB_APP_TOKEN_STATELESS, '[0]'],
  ])('replaces a stateless GitHub App installation token whole past an inner marker: %s', (_what, token, behind) => {
    expect(scanDenyReason(`GITHUB_TOKEN=${token}${behind}`)).toBe(`GITHUB_TOKEN=[REDACTED-GITHUB_APP_TOKEN]${behind}`);
  });

  test.each([
    ['after Bearer', `Authorization: Bearer ${FIX_GITHUB_APP_TOKEN_STATELESS}`, 'Authorization: [REDACTED-GENERIC_BEARER]'],
    [
      'in a URL that is replaced as a whole',
      `https://x-access-token:${FIX_GITHUB_APP_TOKEN_STATELESS}:x-oauth-basic@github.com/o/r.git?t=QuerySecret7`,
      '[REDACTED-CONNECTION_STRING]',
    ],
  ])('leaves the other patterns their match of a stateless token %s', (_where, input, expected) => {
    expect(scanDenyReason(input)).toBe(expected);
  });

  test.each([
    'ghs_123456',
    'see ghs_2024_hazard_statements_and_pictograms.v2.csv',
  ])('does not take "ghs_" and digits alone for a token: %s', (input) => {
    expect(scanDenyReason(input)).toBe(input);
  });

  test.each([
    ['a GitHub App token', `${FIX_GITHUB_APP_TOKEN_STATELESS}${FIX_LIKE_AN_OLDER_TOKEN}-${'s1G-n_'.repeat(10)}`],
    ['a JWT that is no GitHub token', `${FIX_JWT_SIGNED}${FIX_LIKE_AN_OLDER_TOKEN}-${'s1G-n_'.repeat(10)}`],
    ['two such runs, the second like an AWS key id', `${FIX_JWT_SIGNED}${FIX_LIKE_AN_OLDER_TOKEN}-${FIX_AWS_KEY}-${'s1G-n_'.repeat(10)}`],
    ['the run at the end of the token', `${FIX_JWT_SIGNED}${FIX_LIKE_AN_OLDER_TOKEN}`],
    ['padding behind the rest', `${FIX_JWT_SIGNED}${FIX_LIKE_AN_OLDER_TOKEN}-${'s1G-n_'.repeat(10)}==`],
  ])('replaces a bearer token whole past an inner marker: %s', (_what, token) => {
    expect(scanDenyReason(`Authorization: Bearer ${token}`)).toBe('Authorization: [REDACTED-GENERIC_BEARER]');
  });

  test.each([
    ['a marker behind a space', `Authorization: Bearer ${FIX_JWT_SIGNED} ${FIX_AWS_KEY}`, 'Authorization: [REDACTED-GENERIC_BEARER] [REDACTED-AWS_KEY]'],
    [
      'two markers of other patterns, as a file about the scanner holds them',
      'key [REDACTED-AWS_KEY][REDACTED-GITHUB_TOKEN]-tail',
      'key [REDACTED-AWS_KEY][REDACTED-GITHUB_TOKEN]-tail',
    ],
  ])('takes only what follows a bearer marker directly for the rest of a token: %s', (_what, input, expected) => {
    expect(scanDenyReason(input)).toBe(expected);
  });

  test('leaves the other patterns their match of the rest of a bearer token', () => {
    const input = `s3://Bearer ${'x'.repeat(24)}-${FIX_AWS_KEY}:pa/ss@host`;
    expect(scanDenyReason(input)).toBe('[REDACTED-CONNECTION_STRING]');
  });

  test('takes text with a colon for a git remote URL token up to 512 characters', () => {
    expect(scanDenyReason(`x-access-token:a:${'a'.repeat(510)}@`)).toBe('[REDACTED-GITHUB_URL_TOKEN]');
    const overTheLimit = `x-access-token:a:${'a'.repeat(511)}@`;
    expect(scanDenyReason(overTheLimit)).toBe(overTheLimit);
  });

  test('counts a character outside the BMP once in both length limits, as the agent\'s scanner does', () => {
    // Without the u flag a JavaScript regular expression counts it as two.
    const wide = String.fromCodePoint(0x1F600);
    expect(scanDenyReason(`x-access-token:a:${wide.repeat(300)}s3cret@github.com`)).toBe('[REDACTED-GITHUB_URL_TOKEN]github.com');
    expect(scanDenyReason(`postgres://${FIX_AWS_KEY_PAIR}-[${wide.repeat(200)}s3cret@db.internal/app`)).toBe('[REDACTED-CONNECTION_STRING]');
  });

  test('leaves a URL followed by an e-mail address alone', () => {
    const input = 'use https://example.com/guide instead; questions: ops@example.com';
    expect(scanDenyReason(input)).toBe(input);
  });

  test.each(scanVectors.vectors)('gives the text of contracts/secret-scan-vectors.json for $note', ({ input, expected }) => {
    expect(scanDenyReason(input)).toBe(expected);
  });

  test.each(['x://', 'x://y:1/'])('scans a text that repeats %s in a time that grows with its length only', (unit) => {
    const started = Date.now();
    scanDenyReason(unit.repeat(200_000 / unit.length));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test.each([
    'DATABASE_URL = "postgresql+psycopg2://{user}:{password}@{host}:{port}/{db}"',
    'url = f"redis://default:{settings.redis_password}@{host}:6379/0"',
    'conn = "amqp://%s:%s@%s:5672/" % (user, pw, host)',
    'export PGURL="postgres://app:${DB_PASSWORD}@db.internal/app"',
    '# docs: mongodb://<user>:<password>@cluster0.example.net',
    'sqlalchemy.url = postgresql://%(DB_USER)s:%(DB_PASS)s@%(DB_HOST)s/app',
    'run: git clone https://x-access-token:${{secrets.GITHUB_TOKEN}}@github.com/o/r.git',
    'push = f"git push https://x-access-token:{token}@github.com/o/r"',
    'let url = format!("postgres://{}:{}@{}:5432/app", user, pw, host);',
    'url = "postgres://{0}:{1}@{2}/app".format(user, pw, host)',
    'MONGO_URI=mongodb+srv://<USERNAME>:<YOUR_PASSWORD>@cluster0.example.net/app',
    'url = f"postgresql://{settings.DB_USER}:{settings.DB_PASSWORD}@{settings.DB_HOST}/app"',
    'url: redis://default:{{redis_password}}@{{redis_host}}:6379',
    'mongodb+srv://<db-user>:<your-password>@cluster0.example.net',
    'dsn := fmt.Sprintf("postgres://%v:%v@%v/app", user, pass, host)',
  ])('leaves a URL template with a placeholder password as it is: %s', (input) => {
    expect(scanDenyReason(input)).toBe(input);
  });

  test.each([
    [`DATABASE_URL = "postgresql+psycopg2://{user}:${FIX_PASSWORD}@{host}:{port}/{db}"`, 'DATABASE_URL = "[REDACTED-CONNECTION_STRING]"'],
    [`url = f"redis://default:${FIX_PASSWORD}@{host}:6379/0"`, 'url = f"[REDACTED-CONNECTION_STRING]"'],
    [`conn = "amqp://%s:${FIX_PASSWORD}@%s:5672/" % (user, host)`, 'conn = "[REDACTED-CONNECTION_STRING]" % (user, host)'],
    [`export PGURL="postgres://app:${FIX_PASSWORD}@db.internal/app"`, 'export PGURL="[REDACTED-CONNECTION_STRING]"'],
    [`# docs: mongodb://<user>:${FIX_PASSWORD}@cluster0.example.net`, '# docs: [REDACTED-CONNECTION_STRING]'],
    [`sqlalchemy.url = postgresql://%(DB_USER)s:${FIX_PASSWORD}@%(DB_HOST)s/app`, 'sqlalchemy.url = [REDACTED-CONNECTION_STRING]'],
    [`run: git clone https://x-access-token:${FIX_PASSWORD}@github.com/o/r.git`, 'run: git clone https://[REDACTED-GITHUB_URL_TOKEN]github.com/o/r.git'],
  ])('replaces the same URL with a password in the place of the placeholder: %s', (input, expected) => {
    expect(scanDenyReason(input)).toBe(expected);
  });

  test.each([
    '{x}real',
    '${A}b3',
    '%sabc',
    '<a>b',
    '{{x}}y',
    '%(x)sy',
    'real{x}',
    '{a}{b}',
    '$DB_PASSWORD',
    '${DB_PASSWORD:-postgres}',
    '${DB_PASSWORD-postgres}',
    '[password]',
    'password',
    '%d',
    '<pass.word>',
    // MongoDB Atlas hands out "<password>": somebody may leave the brackets around a real password.
    `<${FIX_LETTERS_AND_DIGITS}>`,
    `{${FIX_LETTERS_AND_DIGITS}}`,
    '$' + `{${FIX_LETTERS_AND_DIGITS}}`,
    '{' + '123456' + '}',
    '<' + 'Sunshine' + 'LetMeIn' + '>',
  ])('replaces a password that is not one placeholder and nothing else: %s', (password) => {
    expect(scanDenyReason(`postgres://app:${password}@db.internal/app`)).toBe('[REDACTED-CONNECTION_STRING]');
    expect(scanDenyReason(`https://x-access-token:${password}@github.com/o/r.git`)).toBe('https://[REDACTED-GITHUB_URL_TOKEN]github.com/o/r.git');
  });

  test('takes a placeholder password after an AWS key id for no template', () => {
    expect(scanDenyReason(`https://${FIX_AWS_KEY}:{secret}@files.example.com/x`)).toBe('[REDACTED-CONNECTION_STRING]');
  });

  test('is idempotent — running twice produces the same output', () => {
    const input = `token ${FIX_GITHUB_PAT} bad`;
    const once = scanDenyReason(input);
    const twice = scanDenyReason(once);
    expect(twice).toBe(once);
  });

  test('empty / null input returns empty string', () => {
    expect(scanDenyReason('')).toBe('');
    expect(scanDenyReason(undefined as unknown as string)).toBe('');
  });

  test('redacts multiple distinct secrets in one pass', () => {
    const input = `${FIX_AWS_KEY} plus ${FIX_GITHUB_PAT}`;
    const out = scanDenyReason(input);
    expect(out).toContain('[REDACTED-AWS_KEY]');
    expect(out).toContain('[REDACTED-GITHUB_TOKEN]');
    expect(out).not.toContain(FIX_AWS_KEY);
    expect(out).not.toContain(FIX_GITHUB_PAT);
  });

  test('exports pattern names for external enumeration', () => {
    expect(DENY_REASON_SECRET_NAMES).toContain('AWS_KEY');
    expect(DENY_REASON_SECRET_NAMES).toContain('GITHUB_TOKEN');
    expect(DENY_REASON_SECRET_NAMES).toContain('PRIVATE_KEY');
  });
});
