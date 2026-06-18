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

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { CliError } from '../../src/errors';
import { listRepoConfigs, parseRepoConfigRow } from '../../src/repo-lookup';

const ddbSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: {
      from: jest.fn(() => ({ send: ddbSend })),
    },
  };
});

describe('listRepoConfigs', () => {
  beforeEach(() => {
    ddbSend.mockReset();
  });

  test('returns sorted repo rows from RepoTable scan', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [
        { repo: 'zebra/z', status: 'active' },
        { repo: 'acme/a', status: 'removed' },
      ],
    });

    const repos = await listRepoConfigs('us-east-1', 'RepoTable-dev');
    expect(repos.map((r) => r.repo)).toEqual(['acme/a', 'zebra/z']);
    const scanCmd = ddbSend.mock.calls[0][0] as ScanCommand;
    expect(scanCmd.input.TableName).toBe('RepoTable-dev');
  });

  test('paginates scan results', async () => {
    ddbSend
      .mockResolvedValueOnce({
        Items: [{ repo: 'acme/a', status: 'active' }],
        LastEvaluatedKey: { repo: 'acme/a' },
      })
      .mockResolvedValueOnce({
        Items: [{ repo: 'acme/b', status: 'active' }],
      });

    const repos = await listRepoConfigs('us-east-1', 'RepoTable-dev');
    expect(repos).toHaveLength(2);
    expect(ddbSend).toHaveBeenCalledTimes(2);
  });

  test('rejects a scanned row with an unexpected status', async () => {
    ddbSend.mockResolvedValueOnce({
      Items: [{ repo: 'acme/a', status: 'disabled' }],
    });

    await expect(listRepoConfigs('us-east-1', 'RepoTable-dev')).rejects.toThrow(/unexpected status/);
  });
});

describe('parseRepoConfigRow', () => {
  test('accepts a valid row', () => {
    const row = parseRepoConfigRow({ repo: 'acme/a', status: 'active', max_turns: 10 });
    expect(row.repo).toBe('acme/a');
    expect(row.status).toBe('active');
  });

  test('throws on a non-string repo', () => {
    expect(() => parseRepoConfigRow({ status: 'active' })).toThrow(CliError);
  });

  test('throws on an out-of-union status', () => {
    expect(() => parseRepoConfigRow({ repo: 'acme/a', status: 'paused' }))
      .toThrow(/unexpected status/);
  });
});
