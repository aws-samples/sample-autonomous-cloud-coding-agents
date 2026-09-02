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
import {
  LINEAR_VAULT_CUSTOM_PARAMS,
  LINEAR_VAULT_SCOPES,
} from '../../src/handlers/shared/linear-vault-token';

/**
 * AgentCore keys a cached grant by the WHOLE token request, `customParameters`
 * included — live-proven: the same user and provider return the cached token when they
 * are sent and an `authorizationUrl` ("needs consent") when they are omitted.
 *
 * Four copies of that key exist: this resolver's, the CLI's two, and the agent's. A
 * one-token divergence between any two makes every resolve a cache miss, which since
 * #812 is reported as `consent-required` — and can latch a healthy workspace `revoked`.
 * Four "keep in sync" comments cannot enforce that; `contracts/constants.json` can.
 *
 * The agent side is enforced differently: `check:constants-sync` forbids `config.py`
 * from re-declaring these as literals at all, so it must read the contract.
 */
describe('linear_vault cache key matches contracts/constants.json', () => {
  const contract = (JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', '..', 'contracts', 'constants.json'), 'utf8'),
  ) as { linear_vault: { scopes: string[]; custom_parameters: Record<string, string> } }).linear_vault;

  test('the resolver scopes match the contract', () => {
    expect([...LINEAR_VAULT_SCOPES]).toEqual(contract.scopes);
  });

  test('the resolver customParameters match the contract', () => {
    expect(LINEAR_VAULT_CUSTOM_PARAMS).toEqual(contract.custom_parameters);
  });

  test('the contract is not vacuous', () => {
    // A parity test over an empty contract passes while enforcing nothing.
    expect(contract.scopes.length).toBeGreaterThan(0);
    expect(Object.keys(contract.custom_parameters).length).toBeGreaterThan(0);
  });
});
