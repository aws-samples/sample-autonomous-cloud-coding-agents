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

jest.mock('@aws-sdk/lib-dynamodb', () => ({
  ScanCommand: jest.fn((input: unknown) => ({ input })),
}));

import { resolveSoleActiveJiraTenant } from '../../../src/handlers/shared/jira-tenant-registry';

describe('resolveSoleActiveJiraTenant', () => {
  test('returns the one active tenant across paginated registry rows', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({
        Items: [{ jira_cloud_id: 'removed', status: 'removed' }],
        LastEvaluatedKey: { jira_cloud_id: 'removed' },
      })
      .mockResolvedValueOnce({
        Items: [{ jira_cloud_id: 'cloud-1', status: 'active' }],
      });

    await expect(resolveSoleActiveJiraTenant(
      { send } as never,
      'JiraRegistry',
    )).resolves.toBe('cloud-1');
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('refuses to guess when multiple active tenants exist', async () => {
    const send = jest.fn().mockResolvedValue({
      Items: [
        { jira_cloud_id: 'cloud-1', status: 'active' },
        { jira_cloud_id: 'cloud-2', status: 'active' },
      ],
    });

    await expect(resolveSoleActiveJiraTenant(
      { send } as never,
      'JiraRegistry',
    )).resolves.toBeUndefined();
  });
});
