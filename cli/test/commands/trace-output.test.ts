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
import { ApiClient } from '../../src/api-client';
import { makeTraceCommand } from '../../src/commands/trace';

jest.mock('../../src/api-client');

describe('trace download --output', () => {
  const nodeFs = jest.requireActual<typeof fs>('fs');
  const originalFetch = global.fetch;
  const geteuid = process.geteuid;
  const PAYLOAD = Buffer.from('new trace bytes');
  let tmpDir: string;
  let outFile: string;
  let elsewhere: string;
  let getTraceUrl: jest.Mock;

  function respondWith(...chunks: Array<Uint8Array | Error>): jest.Mock {
    const fetchMock = jest.fn().mockImplementation(async () => {
      const queue = [...chunks];
      const body = new ReadableStream({
        pull(controller) {
          const next = queue.shift();
          if (next === undefined) controller.close();
          else if (next instanceof Error) controller.error(next);
          else controller.enqueue(next);
        },
      });
      return { ok: true, status: 200, statusText: 'OK', body } as unknown as Response;
    });
    global.fetch = fetchMock as typeof global.fetch;
    return fetchMock;
  }

  async function download(...flags: string[]): Promise<void> {
    await makeTraceCommand().parseAsync(['node', 'test', 'download', 'task-1', '-o', outFile, ...flags]);
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-output-'));
    outFile = path.join(tmpDir, 'trace.jsonl.gz');
    elsewhere = path.join(tmpDir, 'elsewhere');
    getTraceUrl = jest.fn().mockResolvedValue({ url: 'https://s3.example/trace', expires_at: '2026-04-30T20:00:00Z' });
    (ApiClient as jest.MockedClass<typeof ApiClient>).mockImplementation(() => ({ getTraceUrl }) as unknown as ApiClient);
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.geteuid = geteuid;
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('creates a new file owner-only', async () => {
    respondWith(PAYLOAD);

    await download();

    expect(fs.readFileSync(outFile)).toEqual(PAYLOAD);
    expect(fs.statSync(outFile).mode % 0o1000).toBe(0o600);
  });

  test('replaces an existing file in one step and leaves it owner-only', async () => {
    fs.writeFileSync(outFile, 'old', { mode: 0o644 });
    const before = fs.statSync(outFile).ino;
    respondWith(PAYLOAD);

    await download('--force');

    expect(fs.readFileSync(outFile)).toEqual(PAYLOAD);
    expect(fs.statSync(outFile).ino).not.toBe(before);
    expect(fs.statSync(outFile).mode % 0o1000).toBe(0o600);
  });

  test('refuses a symbolic link that leads nowhere without --force', async () => {
    fs.symlinkSync(elsewhere, outFile);
    const fetchMock = respondWith(PAYLOAD);

    await expect(download()).rejects.toThrow(/Refusing to overwrite/);

    expect(fs.existsSync(elsewhere)).toBe(false);
    expect(getTraceUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("refuses another user's symbolic link before the download starts", async () => {
    fs.writeFileSync(elsewhere, 'old');
    fs.symlinkSync(elsewhere, outFile);
    process.geteuid = () => 1000;
    const real = nodeFs.lstatSync;
    jest.spyOn(nodeFs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
      const stats = real(file, options) as fs.Stats | undefined;
      return stats && file === outFile ? Object.assign(stats, { uid: 3000 }) : stats;
    }) as typeof fs.lstatSync);
    const fetchMock = respondWith(PAYLOAD);

    await expect(download('--force')).rejects.toThrow(/symbolic link there belongs to another user/);

    expect(fs.readFileSync(elsewhere, 'utf-8')).toBe('old');
    expect(getTraceUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('replaces a symbolic link put at the path during the download instead of following it', async () => {
    fs.writeFileSync(elsewhere, 'old');
    const fetchMock = respondWith(PAYLOAD);
    const respond = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async () => {
      fs.symlinkSync(elsewhere, outFile);
      return respond();
    });

    await download();

    expect(fs.readFileSync(elsewhere, 'utf-8')).toBe('old');
    expect(fs.lstatSync(outFile).isFile()).toBe(true);
    expect(fs.readFileSync(outFile)).toEqual(PAYLOAD);
  });

  test('writes /dev/null in place and keeps its mode', async () => {
    const mode = fs.statSync('/dev/null').mode;
    outFile = '/dev/null';
    respondWith(PAYLOAD);

    await download('--force');

    expect(fs.statSync('/dev/null').mode).toBe(mode);
  });

  test('leaves the old file whole and no temporary file when the download fails midway', async () => {
    fs.writeFileSync(outFile, 'old');
    respondWith(PAYLOAD, new Error('connection reset'));

    await expect(download('--force')).rejects.toThrow('connection reset');

    expect(fs.readFileSync(outFile, 'utf-8')).toBe('old');
    expect(fs.readdirSync(tmpDir)).toEqual(['trace.jsonl.gz']);
  });
});
