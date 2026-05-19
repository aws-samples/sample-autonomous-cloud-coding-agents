/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

/**
 * clipboard.ts unit tests.
 *
 * The new clipboard reader writes via the platform clipboard tool
 * to a temp file then reads it back, so each platform path is
 * exercised by mocking BOTH `node:child_process.spawn` (the tool
 * invocation) AND `node:fs/promises` (the temp file read). A small
 * recorder pairs them: when the spawn succeeds, the temp path
 * passed to spawn (or referenced in argv) gets a fake file body
 * staged, and the next `fs.readFile` for that path returns it.
 */

import { EventEmitter } from 'node:events';

// Mock node:fs so we can intercept fs.promises.readFile / .unlink
// without trying to spyOn read-only ESM exports. The factory keeps
// every other export pass-through to the real module.
//
// Module-level mutable refs let each test stub readFile/unlink
// independently — Jest hoists `jest.mock` above imports, so the
// refs must be `var` declarations (or accessed lazily).
let stagedFiles = new Map<string, Buffer>();
jest.mock('node:fs', () => {
  const actual = jest.requireActual('node:fs') as typeof import('node:fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: async (path: string | Buffer | URL) => {
        const p = typeof path === 'string' ? path : String(path);
        const body = stagedFiles.get(p);
        if (body !== undefined) return body;
        const err = new Error(`ENOENT: no such file ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      },
      unlink: async (_path: unknown) => undefined,
    },
  };
});

import {
  _resetHintCacheForTests,
  readClipboardImage,
  shouldShowHintOnce,
} from '../../src/tui/utils/clipboard';

// Magic-byte buffers used across multiple tests.
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const TEXT_BYTES = Buffer.from('hello world', 'utf8');

interface FakeSpawnSpec {
  /** stdout bytes the fake child emits before close. Used by Linux
   *  TARGETS-query mocks; image-save mocks usually leave this empty
   *  (the tool writes to a file). */
  stdout?: Buffer;
  /** Exit code emitted on close (default 0). */
  exitCode?: number;
  /** Simulate "tool not on PATH" by emitting an ENOENT error. */
  enoent?: boolean;
  /** When set, after the spawn closes successfully, the recorder
   *  installs this body for `fs.readFile` to return on the *next*
   *  read. Use the path captured from the last spawn's args. */
  fileBody?: Buffer;
}

interface RecordedSpawn {
  cmd: string;
  args: string[];
}

const recordedSpawns: RecordedSpawn[] = [];

/** Wire `child_process.spawn` to a programmable fake; the
 *  `fs.promises.readFile` / `unlink` stubs are installed
 *  module-level via `jest.mock('node:fs', ...)` above. Returns the
 *  spawn spy for tests that want to assert call counts.
 *
 *  `fileBody`, when set on a spec, stages bytes for the next
 *  fs.readFile call — paired with the temp path the spawned tool
 *  saw in its argv. */
function mockClipboard(specs: FakeSpawnSpec[]): { spawnSpy: jest.SpyInstance } {
  recordedSpawns.length = 0;
  stagedFiles.clear();
  const queue = [...specs];

  const cp = jest.requireActual('node:child_process') as typeof import('node:child_process');
  const spawnSpy = jest.spyOn(cp, 'spawn').mockImplementation((cmd: unknown, args: unknown = []) => {
    const cmdStr = String(cmd);
    const argsArr = Array.isArray(args) ? args.map(String) : [];
    recordedSpawns.push({ cmd: cmdStr, args: argsArr });

    const spec = queue.shift() ?? { exitCode: 0 };

    // If the spec provides a fileBody, find the temp path in argv
    // (or in shell-string args for Linux) and stage it.
    if (spec.fileBody !== undefined) {
      const allArgs = `${cmdStr} ${argsArr.join(' ')}`;
      const match = allArgs.match(/bgagent-tui-clipboard-[a-f0-9]+\.png/);
      if (match) {
        // Reconstruct the absolute path: tmpdir + filename.
        const fname = match[0];
        // Look for the full path containing this filename — it
        // appears either as a quoted string ("/tmp/.../foo.png")
        // or as an unquoted argument.
        const pathMatch = allArgs.match(new RegExp(`["']?(/[^"'\\s]*${fname.replace('.', '\\.')})["']?`));
        if (pathMatch) {
          stagedFiles.set(pathMatch[1], spec.fileBody);
        } else {
          // Windows path matching, or when path appears as a bare
          // arg. Fall back to scanning argv individually for any
          // string ending in our filename.
          const arg = argsArr.find(a => a.includes(fname));
          if (arg) {
            const cleaned = arg.replace(/['"]/g, '').match(new RegExp(`[^"' ]*${fname.replace('.', '\\.')}`));
            if (cleaned) stagedFiles.set(cleaned[0], spec.fileBody);
          }
        }
      }
    }

    const stdout = new EventEmitter() as EventEmitter & { on: EventEmitter['on'] };
    const stderr = new EventEmitter();
    const stdin = { end: jest.fn() };
    const child = new EventEmitter() as EventEmitter & {
      stdout: typeof stdout;
      stderr: typeof stderr;
      stdin: typeof stdin;
      kill: jest.Mock;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = stdin;
    child.kill = jest.fn();
    process.nextTick(() => {
      if (spec.enoent) {
        const err = new Error('spawn ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
        return;
      }
      if (spec.stdout && spec.stdout.length > 0) {
        stdout.emit('data', spec.stdout);
      }
      child.emit('close', spec.exitCode ?? 0);
    });
    return child as unknown as ReturnType<typeof cp.spawn>;
  });

  return { spawnSpy };
}

describe('clipboard.readClipboardImage — magic-byte sniff', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    _resetHintCacheForTests();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    jest.restoreAllMocks();
  });

  it('detects PNG magic bytes', async () => {
    mockClipboard([{ exitCode: 0, fileBody: PNG_HEADER }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.mediaType).toBe('image/png');
      expect(r.image.sizeBytes).toBe(PNG_HEADER.length);
      expect(r.image.base64).toBe(PNG_HEADER.toString('base64'));
    }
  });

  it('detects JPEG magic bytes', async () => {
    mockClipboard([{ exitCode: 0, fileBody: JPEG_HEADER }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.mediaType).toBe('image/jpeg');
  });

  it('detects GIF magic bytes', async () => {
    mockClipboard([{ exitCode: 0, fileBody: GIF_HEADER }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.mediaType).toBe('image/gif');
  });

  it('rejects non-image bytes with not_image', async () => {
    mockClipboard([{ exitCode: 0, fileBody: TEXT_BYTES }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('not_image');
  });

  it('returns empty when temp file is empty', async () => {
    mockClipboard([{ exitCode: 0, fileBody: Buffer.alloc(0) }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('empty');
  });
});

describe('clipboard.readClipboardImage — macOS (osascript)', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    _resetHintCacheForTests();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    jest.restoreAllMocks();
  });

  it('invokes osascript and returns PNG when the clipboard has an image', async () => {
    mockClipboard([{ exitCode: 0, fileBody: PNG_HEADER }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    expect(recordedSpawns[0].cmd).toBe('osascript');
    // The script should reference the «class PNGf» AppleScript
    // coercion + the temp file path.
    expect(recordedSpawns[0].args.join(' ')).toMatch(/«class PNGf»/);
    expect(recordedSpawns[0].args.join(' ')).toMatch(/bgagent-tui-clipboard-/);
  });

  it('returns empty when osascript exits non-zero (no image on clipboard)', async () => {
    mockClipboard([{ exitCode: 1 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('empty');
  });

  it('returns tool_missing only when osascript itself is missing (very unusual)', async () => {
    mockClipboard([{ enoent: true }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === 'tool_missing') {
      expect(r.failure.platform).toBe('darwin');
      expect(r.failure.hint).toMatch(/osascript/i);
    } else {
      throw new Error(`expected tool_missing; got ${JSON.stringify(r)}`);
    }
  });
});

describe('clipboard.readClipboardImage — linux', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  let originalDisplay: string | undefined;
  let originalWayland: string | undefined;
  beforeEach(() => {
    _resetHintCacheForTests();
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    originalDisplay = process.env.DISPLAY;
    originalWayland = process.env.WAYLAND_DISPLAY;
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    if (originalDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = originalDisplay;
    if (originalWayland === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = originalWayland;
    jest.restoreAllMocks();
  });

  it('uses xclip and TARGETS-query when DISPLAY is set', async () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.DISPLAY = ':0';
    // First spawn = xclip TARGETS query (returns image MIME types).
    // Second spawn = shell-redirected save (writes to temp file).
    mockClipboard([
      { exitCode: 0, stdout: Buffer.from('TIMESTAMP\nimage/png\nimage/bmp\n') },
      { exitCode: 0, fileBody: PNG_HEADER },
    ]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    expect(recordedSpawns[0].cmd).toBe('xclip');
    expect(recordedSpawns[0].args).toContain('TARGETS');
  });

  it('uses wl-paste when WAYLAND_DISPLAY is set', async () => {
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    mockClipboard([
      { exitCode: 0, stdout: Buffer.from('image/png\ntext/plain\n') },
      { exitCode: 0, fileBody: PNG_HEADER },
    ]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    expect(recordedSpawns[0].cmd).toBe('wl-paste');
  });

  it('returns empty when TARGETS query reports no image MIME', async () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.DISPLAY = ':0';
    mockClipboard([{ exitCode: 0, stdout: Buffer.from('TIMESTAMP\ntext/plain\nUTF8_STRING\n') }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('empty');
  });

  it('returns tool_missing with hint when no display server is detected', async () => {
    delete process.env.DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === 'tool_missing') {
      expect(r.failure.hint).toMatch(/X11 or Wayland/i);
    } else {
      throw new Error(`expected tool_missing; got ${JSON.stringify(r)}`);
    }
  });
});

describe('clipboard.shouldShowHintOnce', () => {
  beforeEach(() => _resetHintCacheForTests());

  it('returns true on first call, false on subsequent calls for the same key', () => {
    expect(shouldShowHintOnce('foo')).toBe(true);
    expect(shouldShowHintOnce('foo')).toBe(false);
    expect(shouldShowHintOnce('foo')).toBe(false);
  });

  it('keeps hint cache per-key (different tools fire independently)', () => {
    expect(shouldShowHintOnce('mac')).toBe(true);
    expect(shouldShowHintOnce('linux')).toBe(true);
    expect(shouldShowHintOnce('mac')).toBe(false);
  });

  it('reset clears the cache (test helper)', () => {
    shouldShowHintOnce('foo');
    _resetHintCacheForTests();
    expect(shouldShowHintOnce('foo')).toBe(true);
  });
});

describe('clipboard.readClipboardImage — unsupported platform', () => {
  let originalPlatform: PropertyDescriptor | undefined;
  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });
  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('returns unsupported_platform on aix / freebsd / etc.', async () => {
    Object.defineProperty(process, 'platform', { value: 'aix' });
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === 'unsupported_platform') {
      expect(r.failure.platform).toBe('aix');
    } else {
      throw new Error(`expected unsupported_platform; got ${JSON.stringify(r)}`);
    }
  });
});
