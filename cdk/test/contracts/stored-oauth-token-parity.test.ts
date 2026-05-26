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

/**
 * Cross-language contract: the JSON schema written into Secrets Manager
 * by the CLI's `bgagent linear setup` MUST match what the Lambda-side
 * resolver expects to read. Two TypeScript interfaces define the shape
 * independently — `StoredLinearOauthToken` (CLI) and `StoredOauthToken`
 * (Lambda). Without a contract test, drift between the two is a silent
 * runtime bug: CLI writes `installer_user_id`, Lambda reads
 * `installed_by_platform_user_id`, refresh works, every Lambda
 * invocation logs a missing-field error.
 *
 * This test parses both interface definitions out of source and
 * asserts the field set is equal. It deliberately avoids importing
 * the CLI (cross-package import would couple build orders); a
 * lightweight regex-extract is enough to keep the schemas honest.
 */

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const LAMBDA_RESOLVER = path.join(REPO_ROOT, 'cdk', 'src', 'handlers', 'shared', 'linear-oauth-resolver.ts');
const CLI_OAUTH = path.join(REPO_ROOT, 'cli', 'src', 'linear-oauth.ts');

function extractInterfaceFields(source: string, interfaceName: string): string[] {
  const reBlock = new RegExp(`export\\s+interface\\s+${interfaceName}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const match = reBlock.exec(source);
  if (!match) {
    throw new Error(`Could not find interface ${interfaceName}`);
  }
  const body = match[1];
  const fields: string[] = [];
  // Match `readonly <name>:` or `<name>:` field declarations. Skip
  // lines that are inside JSDoc comment blocks (start with `*`) or
  // single-line comments (`//`).
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('/*') || line.startsWith('*')) continue;
    const fieldMatch = /^(?:readonly\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/.exec(line);
    if (fieldMatch) {
      fields.push(fieldMatch[1]);
    }
  }
  return fields;
}

describe('StoredOauthToken / StoredLinearOauthToken cross-language parity', () => {
  test('Lambda and CLI define the same set of fields', () => {
    const lambdaSource = fs.readFileSync(LAMBDA_RESOLVER, 'utf8');
    const cliSource = fs.readFileSync(CLI_OAUTH, 'utf8');

    const lambdaFields = extractInterfaceFields(lambdaSource, 'StoredOauthToken').sort();
    const cliFields = extractInterfaceFields(cliSource, 'StoredLinearOauthToken').sort();

    expect(lambdaFields).toEqual(cliFields);
    // Sanity: at least 11 fields per the documented schema. Catches
    // a regex parse failure that returns empty arrays.
    expect(lambdaFields.length).toBeGreaterThanOrEqual(11);
  });

  test('Lambda STORED_OAUTH_TOKEN_REQUIRED_FIELDS const matches the interface', () => {
    const lambdaSource = fs.readFileSync(LAMBDA_RESOLVER, 'utf8');
    const interfaceFields = extractInterfaceFields(lambdaSource, 'StoredOauthToken').sort();

    const constMatch = /STORED_OAUTH_TOKEN_REQUIRED_FIELDS:\s*ReadonlyArray<keyof StoredOauthToken>\s*=\s*\[([\s\S]*?)\];/.exec(lambdaSource);
    expect(constMatch).not.toBeNull();
    const constFields = (constMatch![1].match(/'([a-zA-Z_][a-zA-Z0-9_]*)'/g) ?? [])
      .map((s) => s.replace(/'/g, ''))
      .sort();

    expect(constFields).toEqual(interfaceFields);
  });
});
