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

import { ApiClient } from '../../src/api-client';
import { makeSlackCommand } from '../../src/commands/slack';

jest.mock('../../src/api-client');

describe('slack command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;
  const mockSlackLink = jest.fn();

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    mockSlackLink.mockReset();
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({
      createTask: jest.fn(),
      listTasks: jest.fn(),
      getTask: jest.fn(),
      cancelTask: jest.fn(),
      getTaskEvents: jest.fn(),
      createWebhook: jest.fn(),
      listWebhooks: jest.fn(),
      revokeWebhook: jest.fn(),
      slackLink: mockSlackLink,
    }) as unknown as ApiClient);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('slack link', () => {
    const linkResponse = {
      slack_team_id: 'T0123ABC',
      slack_user_id: 'U0456DEF',
      linked_at: '2026-04-14T12:00:00Z',
    };

    test('links a Slack account with a verification code', async () => {
      mockSlackLink.mockResolvedValue(linkResponse);

      const cmd = makeSlackCommand();
      await cmd.parseAsync(['node', 'test', 'link', 'A1B2C3']);

      expect(mockSlackLink).toHaveBeenCalledWith('A1B2C3');
      const calls = consoleSpy.mock.calls.map(c => c[0]) as string[];
      expect(calls.some(c => c.includes('linked successfully'))).toBe(true);
      expect(calls.some(c => c.includes('T0123ABC'))).toBe(true);
      expect(calls.some(c => c.includes('U0456DEF'))).toBe(true);
    });

    test('outputs JSON when --output json', async () => {
      mockSlackLink.mockResolvedValue(linkResponse);

      const cmd = makeSlackCommand();
      await cmd.parseAsync(['node', 'test', 'link', 'A1B2C3', '--output', 'json']);

      expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(linkResponse, null, 2));
    });

    test('passes the code argument to the API client', async () => {
      mockSlackLink.mockResolvedValue(linkResponse);

      const cmd = makeSlackCommand();
      await cmd.parseAsync(['node', 'test', 'link', 'XYZ789']);

      expect(mockSlackLink).toHaveBeenCalledWith('XYZ789');
    });
  });
});
