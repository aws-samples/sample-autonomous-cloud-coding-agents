/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

/**
 * clipboard.ts unit tests — exercise the per-platform reader logic
 * by mocking node:child_process.spawn. Each test simulates a
 * spawned tool emitting bytes (or failing with ENOENT) and asserts
 * the result discriminator + post-conditions (size cap, magic-byte
 * sniff, install-hint cache).
 */

import { EventEmitter } from 'node:events';
import {
  DEFAULT_MAX_IMAGE_BYTES,
  _resetHintCacheForTests,
  readClipboardImage,
  shouldShowHintOnce,
} from '../../src/tui/utils/clipboard';

// Magic-byte buffers used across multiple tests.
const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, // a few padding bytes so it looks "real"
]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const GIF_HEADER = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const TEXT_BYTES = Buffer.from('hello world', 'utf8');

interface FakeSpawnSpec {
  /** stdout bytes the fake child emits before close. */
  stdout?: Buffer;
  /** Exit code emitted on close (default 0). */
  exitCode?: number;
  /** When set, the child errors with ENOENT instead of emitting
   *  bytes. Simulates "tool not on PATH". */
  enoent?: boolean;
}

/** Wire `child_process.spawn` to return a programmable fake. */
function mockSpawn(specs: FakeSpawnSpec[]): jest.SpyInstance {
  const mod = jest.requireActual('node:child_process') as typeof import('node:child_process');
  const queue = [...specs];
  const spy = jest.spyOn(mod, 'spawn').mockImplementation((..._args: unknown[]) => {
    const spec = queue.shift() ?? { stdout: Buffer.alloc(0), exitCode: 0 };
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
    return child as unknown as ReturnType<typeof mod.spawn>;
  });
  return spy;
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

  it('detects PNG magic bytes from pngpaste exit-0', async () => {
    mockSpawn([{ stdout: PNG_HEADER, exitCode: 0 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.image.mediaType).toBe('image/png');
      expect(r.image.sizeBytes).toBe(PNG_HEADER.length);
      expect(r.image.base64).toBe(PNG_HEADER.toString('base64'));
    }
  });

  it('detects JPEG magic bytes', async () => {
    mockSpawn([{ stdout: JPEG_HEADER, exitCode: 0 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.mediaType).toBe('image/jpeg');
  });

  it('detects GIF magic bytes', async () => {
    mockSpawn([{ stdout: GIF_HEADER, exitCode: 0 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.mediaType).toBe('image/gif');
  });

  it('rejects non-image bytes with not_image when bytes pass through', async () => {
    // pngpaste exit-0 with text would be unusual, but we still
    // sniff and reject — never claim text is an image.
    mockSpawn([{ stdout: TEXT_BYTES, exitCode: 0 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('not_image');
  });
});

describe('clipboard.readClipboardImage — macOS path', () => {
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

  it('falls back to pbpaste when pngpaste is missing', async () => {
    mockSpawn([
      { enoent: true },                          // pngpaste missing
      { stdout: PNG_HEADER, exitCode: 0 },       // pbpaste returns PNG bytes
    ]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.image.mediaType).toBe('image/png');
  });

  it('returns empty when pngpaste runs but exits 1', async () => {
    // pngpaste exit 1 is the canonical "no image on clipboard"
    // signal — must NOT fall through to pbpaste, since pbpaste
    // would happily return text bytes that pass length>0 but
    // fail magic-byte sniff (a confusing not_image instead of
    // empty).
    mockSpawn([{ stdout: Buffer.alloc(0), exitCode: 1 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('empty');
  });

  it('rejects oversize images with too_large + size detail', async () => {
    const huge = Buffer.concat([PNG_HEADER, Buffer.alloc(DEFAULT_MAX_IMAGE_BYTES)]);
    mockSpawn([{ stdout: huge, exitCode: 0 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === 'too_large') {
      expect(r.failure.sizeBytes).toBeGreaterThan(DEFAULT_MAX_IMAGE_BYTES);
      expect(r.failure.maxBytes).toBe(DEFAULT_MAX_IMAGE_BYTES);
    } else {
      throw new Error(`expected too_large; got ${JSON.stringify(r)}`);
    }
  });
});

describe('clipboard.readClipboardImage — linux path', () => {
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

  it('uses xclip when DISPLAY is set', async () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.DISPLAY = ':0';
    const spy = mockSpawn([{ stdout: PNG_HEADER, exitCode: 0 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toBe('xclip');
  });

  it('uses wl-paste when WAYLAND_DISPLAY is set', async () => {
    delete process.env.DISPLAY;
    process.env.WAYLAND_DISPLAY = 'wayland-0';
    const spy = mockSpawn([{ stdout: PNG_HEADER, exitCode: 0 }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(true);
    expect(spy.mock.calls[0]?.[0]).toBe('wl-paste');
  });

  it('returns tool_missing with hint when no display server detected (SSH/headless)', async () => {
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

  it('returns tool_missing with install hint when xclip is not installed', async () => {
    delete process.env.WAYLAND_DISPLAY;
    process.env.DISPLAY = ':0';
    mockSpawn([{ enoent: true }]);
    const r = await readClipboardImage();
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === 'tool_missing') {
      expect(r.failure.hint).toMatch(/xclip/);
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
