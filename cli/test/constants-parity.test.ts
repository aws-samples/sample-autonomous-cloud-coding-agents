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
  APPROVAL_TIMEOUT_S_DEFAULT,
  APPROVAL_TIMEOUT_S_MAX,
  APPROVAL_TIMEOUT_S_MIN,
  MAX_BUDGET_USD_MAX,
  MAX_BUDGET_USD_MIN,
} from '../src/types';

/**
 * The CLI hard-codes these bounds as literals in ``src/types.ts`` rather than
 * importing ``contracts/constants.json`` directly: the contract file lives
 * outside the package's published ``files: ["lib"]`` whitelist, so a compiled
 * ``require('../../contracts/constants.json')`` from ``lib/`` would not be
 * packaged and would fail at runtime when the CLI is installed standalone.
 *
 * This test converts the resulting silent-drift risk into a CI failure: if the
 * single source of truth (the CDK side reads the same file via
 * ``resolveJsonModule``) changes, the CLI literals must be updated to match or
 * this test goes red.
 */
describe('CLI constants parity with contracts/constants.json', () => {
  const contracts = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', 'contracts', 'constants.json'),
      'utf-8',
    ),
  ) as {
    approval_timeout_s: { min: number; max: number; default: number };
    max_budget_usd: { min: number; max: number };
  };

  test('approval_timeout_s bounds match the contract', () => {
    expect(APPROVAL_TIMEOUT_S_MIN).toBe(contracts.approval_timeout_s.min);
    expect(APPROVAL_TIMEOUT_S_MAX).toBe(contracts.approval_timeout_s.max);
    expect(APPROVAL_TIMEOUT_S_DEFAULT).toBe(contracts.approval_timeout_s.default);
  });

  test('max_budget_usd bounds match the contract', () => {
    expect(MAX_BUDGET_USD_MIN).toBe(contracts.max_budget_usd.min);
    expect(MAX_BUDGET_USD_MAX).toBe(contracts.max_budget_usd.max);
  });
});
