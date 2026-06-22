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

import { makePlatformCommand } from '../../src/commands/platform';
import { CliError } from '../../src/errors';
import { runPlatformDoctor } from '../../src/platform-doctor';
import { listStackOutputs } from '../../src/stack-outputs';

jest.mock('../../src/platform-doctor', () => {
  const actual = jest.requireActual('../../src/platform-doctor');
  return { ...actual, runPlatformDoctor: jest.fn() };
});
jest.mock('../../src/stack-outputs', () => {
  const actual = jest.requireActual('../../src/stack-outputs');
  return { ...actual, listStackOutputs: jest.fn() };
});

const runPlatformDoctorMock = runPlatformDoctor as jest.Mock;
const listStackOutputsMock = listStackOutputs as jest.Mock;

describe('platform outputs command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    listStackOutputsMock.mockReset();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('partitions highlighted outputs above the rest in text mode', async () => {
    listStackOutputsMock.mockResolvedValue([
      { key: 'ApiUrl', value: 'https://api.example/v1/' },
      { key: 'SomeOther', value: 'value-x' },
      { key: 'UserPoolId', value: 'us-east-1_pool' },
    ]);

    const cmd = makePlatformCommand();
    await cmd.parseAsync(['node', 'test', 'outputs', '--region', 'us-east-1']);

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('Key outputs:');
    expect(output).toContain('ApiUrl');
    expect(output).toContain('All outputs:');
    expect(output).toContain('SomeOther');
    // Key outputs section must precede the catch-all section.
    expect(output.indexOf('Key outputs:')).toBeLessThan(output.indexOf('All outputs:'));
  });

  test('emits JSON envelope when --output json', async () => {
    listStackOutputsMock.mockResolvedValue([{ key: 'ApiUrl', value: 'https://api.example/v1/' }]);

    const cmd = makePlatformCommand();
    await cmd.parseAsync(['node', 'test', 'outputs', '--region', 'us-east-1', '--output', 'json']);

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ region: 'us-east-1', outputs: [{ key: 'ApiUrl' }] });
  });

  test('throws when the stack has no outputs', async () => {
    listStackOutputsMock.mockResolvedValue([]);

    const cmd = makePlatformCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'outputs', '--region', 'us-east-1']),
    ).rejects.toThrow(/has no outputs/);
  });
});

describe('platform doctor command', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    runPlatformDoctorMock.mockReset();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('exits 0 (no throw) when all checks pass', async () => {
    runPlatformDoctorMock.mockResolvedValue([
      { id: 'api_reachable', label: 'API', status: 'pass', detail: 'ok' },
      { id: 'github_token', label: 'token', status: 'warn', detail: 'warn' },
    ]);

    const cmd = makePlatformCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'doctor', '--region', 'us-east-1']),
    ).resolves.toBeDefined();

    const output = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(output).toContain('All checks passed');
  });

  test('throws CliError with exit code 1 when a check fails', async () => {
    runPlatformDoctorMock.mockResolvedValue([
      { id: 'api_reachable', label: 'API', status: 'fail', detail: 'down' },
    ]);

    const cmd = makePlatformCommand();
    let thrown: unknown;
    try {
      await cmd.parseAsync(['node', 'test', 'doctor', '--region', 'us-east-1']);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).exitCode).toBe(1);
  });

  test('reports failure verdict in JSON mode and still throws', async () => {
    runPlatformDoctorMock.mockResolvedValue([
      { id: 'api_reachable', label: 'API', status: 'fail', detail: 'down' },
    ]);

    const cmd = makePlatformCommand();
    await expect(
      cmd.parseAsync(['node', 'test', 'doctor', '--region', 'us-east-1', '--output', 'json']),
    ).rejects.toThrow(/failing checks/);

    const parsed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
    expect(parsed.passed).toBe(false);
  });
});
