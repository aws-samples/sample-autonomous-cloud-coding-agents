/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

/**
 * Cross-platform clipboard image reader.
 *
 * Strategy: spawn the platform's native clipboard tool to write the
 * image to a temp file, then read it back. Temp-file approach is
 * more robust for binary data than piping through stdout (Windows
 * console encoding mangles non-text bytes; macOS osascript only
 * exposes a write-to-file path for PNG via AppleScript).
 *
 * No system tools require user installation:
 *
 *   macOS    osascript     (always present in /usr/bin/osascript)
 *            AppleScript: `the clipboard as «class PNGf»` coerces
 *            any image on the pasteboard into PNG bytes.
 *
 *   Linux    xclip OR wl-paste — most distros ship one or the other.
 *            We probe both (TARGETS query) and pick whichever is
 *            present. SSH / headless sessions return tool_missing.
 *
 *   Windows  powershell.exe + System.Windows.Forms.Clipboard.GetImage().
 *            Built into Windows 7+. Reachable from WSL via `/mnt/c`
 *            interop, no platform branch needed.
 *
 * BMP fallback (Linux/Windows clipboards sometimes only expose BMP):
 * we read the file, sniff the magic bytes, and decode BMP → PNG via
 * `sharp` so the wire payload is always one of the API-supported
 * formats.
 *
 * Size cap: 5 MB after any decode/conversion. Oversize returns
 * `too_large` with the actual byte count.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';

/** Caller-facing payload for an attached image. */
export interface ClipboardImage {
  /** Raw image bytes — always PNG/JPEG/GIF (BMP is decoded server-side). */
  readonly buffer: Buffer;
  /** MIME type, set from magic-byte sniff (post-decode). */
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif';
  /** Convenience for the API contract — base64 of `buffer`. */
  readonly base64: string;
  /** Byte length. */
  readonly sizeBytes: number;
}

/** Why a clipboard read returned no image. */
export type ClipboardReadFailure =
  | { readonly kind: 'empty' }
  | { readonly kind: 'not_image' }
  | { readonly kind: 'too_large'; readonly sizeBytes: number; readonly maxBytes: number }
  | { readonly kind: 'tool_missing'; readonly platform: NodeJS.Platform; readonly hint: string }
  | { readonly kind: 'unsupported_platform'; readonly platform: NodeJS.Platform }
  | { readonly kind: 'error'; readonly message: string };

export type ClipboardReadResult =
  | { readonly ok: true; readonly image: ClipboardImage }
  | { readonly ok: false; readonly failure: ClipboardReadFailure };

/** Default per-image cap. Common API limit for vision attachments. */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Module-level cache so install hints (rare — e.g. headless Linux)
 *  surface once per session rather than on every Ctrl+V. */
const hintShownFor = new Set<string>();

/** Sniff the leading bytes for a recognized image format. Returns
 *  null when the buffer doesn't match any. */
function sniffMediaType(buf: Buffer):
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/bmp'
  | null {
  if (buf.length < 4) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'image/bmp';
  }
  return null;
}

interface SpawnResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly toolMissing: boolean;
}

/** Async wrapper around spawn that captures stdout. Test seam: tests
 *  mock `node:child_process.spawn` to control return values. */
export async function spawnAndCollect(
  cmd: string,
  args: readonly string[],
  opts: { readonly stdin?: string; readonly timeoutMs?: number; readonly shell?: boolean } = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: opts.shell ?? false,
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    let killed = false;

    const timeoutMs = opts.timeoutMs ?? 5_000;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      clearTimeout(timer);
      const toolMissing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      resolve({
        stdout: Buffer.concat(chunks),
        stderr: err.message,
        exitCode: null,
        toolMissing,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(chunks),
        stderr: killed ? `${stderr}\n(timed out)` : stderr,
        exitCode: code,
        toolMissing: false,
      });
    });

    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/** Generate a fresh temp file path for a clipboard read. We don't
 *  reuse a fixed name across reads because two TUI panels (or two
 *  fast successive pastes) could race on the same path. */
function tempImagePath(): string {
  const id = randomBytes(8).toString('hex');
  return join(tmpdir(), `bgagent-tui-clipboard-${id}.png`);
}

/** Read a temp file, sniff format, decode BMP → PNG via sharp if
 *  needed, apply the size cap, and emit the caller-facing result.
 *  The temp file is unlinked on the way out (best-effort). */
async function fileToImage(path: string, maxBytes: number): Promise<ClipboardReadResult> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(path);
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'error', message: `temp file read failed: ${(err as Error).message}` },
    };
  } finally {
    fs.unlink(path).catch(() => { /* best effort */ });
  }

  if (raw.length === 0) {
    return { ok: false, failure: { kind: 'empty' } };
  }

  const sniffed = sniffMediaType(raw);
  if (sniffed === null) {
    return { ok: false, failure: { kind: 'not_image' } };
  }

  // BMP isn't always accepted by vision APIs (and the wire contract
  // expects `image/png` / `image/jpeg` / `image/gif`). Decode BMP
  // → PNG inline so the rest of the system never sees BMP.
  let buf = raw;
  let mediaType: 'image/png' | 'image/jpeg' | 'image/gif';
  if (sniffed === 'image/bmp') {
    try {
      buf = await sharp(raw).png().toBuffer();
      mediaType = 'image/png';
    } catch (err) {
      return {
        ok: false,
        failure: { kind: 'error', message: `BMP decode failed: ${(err as Error).message}` },
      };
    }
  } else {
    mediaType = sniffed;
  }

  if (buf.length > maxBytes) {
    return {
      ok: false,
      failure: { kind: 'too_large', sizeBytes: buf.length, maxBytes },
    };
  }

  return {
    ok: true,
    image: {
      buffer: buf,
      mediaType,
      base64: buf.toString('base64'),
      sizeBytes: buf.length,
    },
  };
}

/* ─── Per-platform readers ───────────────────────────────────────── */

/**
 * macOS: AppleScript via `osascript`. The `«class PNGf»` coercion
 * asks the pasteboard for its PNG representation, which the OS
 * synthesizes from any image present (including from screenshot
 * tools, image apps, and copies of TIFF/JPEG/etc). osascript is
 * always at /usr/bin/osascript on macOS — no install needed.
 */
async function readMacOS(maxBytes: number): Promise<ClipboardReadResult> {
  const path = tempImagePath();
  // Two-step AppleScript: coerce clipboard → PNG bytes, then write
  // those bytes to the temp file. The `open for access` /
  // `close access` dance is the canonical way to write binary data
  // from AppleScript. If the clipboard has no image, the coercion
  // throws and osascript exits non-zero.
  const script = [
    `set png_data to (the clipboard as «class PNGf»)`,
    `set fp to open for access POSIX file "${path}" with write permission`,
    `write png_data to fp`,
    `close access fp`,
  ].join('\n');

  const result = await spawnAndCollect('osascript', ['-e', script]);
  if (result.toolMissing) {
    return {
      ok: false,
      failure: {
        kind: 'tool_missing',
        platform: 'darwin',
        hint: 'osascript is missing — this is unusual on macOS. Reinstall macOS dev tools.',
      },
    };
  }
  if (result.exitCode !== 0) {
    // osascript exits non-zero when the clipboard has no image.
    // Make sure we don't leave a partially-written temp file
    // around if the script created one before failing.
    fs.unlink(path).catch(() => { /* best effort */ });
    return { ok: false, failure: { kind: 'empty' } };
  }
  return fileToImage(path, maxBytes);
}

/** Probe whether xclip / wl-paste exposes any image MIME type on
 *  the clipboard. We use this as a fast pre-check so we don't write
 *  empty temp files on text-only clipboards. */
async function linuxHasImage(tool: 'xclip' | 'wl-paste'): Promise<boolean> {
  if (tool === 'xclip') {
    const r = await spawnAndCollect('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']);
    if (r.exitCode !== 0) return false;
    const targets = r.stdout.toString('utf8');
    return /image\/(png|jpeg|jpg|gif|webp|bmp)/.test(targets);
  }
  // wl-paste -l lists available types
  const r = await spawnAndCollect('wl-paste', ['-l']);
  if (r.exitCode !== 0) return false;
  const targets = r.stdout.toString('utf8');
  return /image\/(png|jpeg|jpg|gif|webp|bmp)/.test(targets);
}

async function readLinux(maxBytes: number): Promise<ClipboardReadResult> {
  const isWayland = !!process.env.WAYLAND_DISPLAY;
  const isX11 = !!process.env.DISPLAY;
  if (!isWayland && !isX11) {
    return {
      ok: false,
      failure: {
        kind: 'tool_missing',
        platform: 'linux',
        hint: 'No display server detected. Clipboard paste requires X11 or Wayland\n(this looks like a headless / SSH session).',
      },
    };
  }

  const tool: 'xclip' | 'wl-paste' = isWayland ? 'wl-paste' : 'xclip';

  // Pre-check: does the clipboard expose any image MIME?
  const hasImage = await linuxHasImage(tool).catch(() => false);
  if (!hasImage) {
    return { ok: false, failure: { kind: 'empty' } };
  }

  // Save with format-fallback chain. Prefer PNG; fall back to BMP
  // (some apps — notably Windows-via-WSL2 — only expose BMP). The
  // file is written via shell redirect so we use shell:true here.
  const path = tempImagePath();
  const escapedPath = path.replace(/"/g, '\\"');
  const cmd = tool === 'xclip'
    ? [
      `xclip -selection clipboard -t image/png -o > "${escapedPath}" 2>/dev/null`,
      `xclip -selection clipboard -t image/bmp -o > "${escapedPath}" 2>/dev/null`,
    ].join(' || ')
    : [
      `wl-paste --type image/png > "${escapedPath}" 2>/dev/null`,
      `wl-paste --type image/bmp > "${escapedPath}" 2>/dev/null`,
    ].join(' || ');

  const result = await spawnAndCollect(cmd, [], { shell: true });
  if (result.toolMissing) {
    return {
      ok: false,
      failure: {
        kind: 'tool_missing',
        platform: 'linux',
        hint: tool === 'wl-paste'
          ? 'wl-clipboard is required for clipboard paste on Wayland:\n  sudo apt install wl-clipboard'
          : 'xclip is required for clipboard paste on X11:\n  sudo apt install xclip',
      },
    };
  }
  // Even if exit code is non-zero, the OR-chain may have produced a
  // file via the BMP fallback. Just try to read it.
  return fileToImage(path, maxBytes);
}

/**
 * Windows: PowerShell + System.Windows.Forms.Clipboard.GetImage().
 * Saves to a temp file. Reachable from WSL via the `/mnt/c` interop
 * since `powershell.exe` is on PATH there too, so no platform
 * branch.
 */
async function readWindows(maxBytes: number): Promise<ClipboardReadResult> {
  const path = tempImagePath();
  // Backslash-escape for PowerShell single-quoted string.
  const psPath = path.replace(/\\/g, '\\\\').replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `Add-Type -AssemblyName System.Windows.Forms`,
    `Add-Type -AssemblyName System.Drawing`,
    `$img = [System.Windows.Forms.Clipboard]::GetImage()`,
    `if ($null -eq $img) { exit 1 }`,
    `$img.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  ].join('; ');

  const result = await spawnAndCollect(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
  );
  if (result.toolMissing) {
    return {
      ok: false,
      failure: {
        kind: 'tool_missing',
        platform: 'win32',
        hint: 'powershell.exe was not found on PATH (required for clipboard paste).',
      },
    };
  }
  if (result.exitCode !== 0) {
    fs.unlink(path).catch(() => { /* best effort */ });
    return { ok: false, failure: { kind: 'empty' } };
  }
  return fileToImage(path, maxBytes);
}

/** Public API. Returns a result discriminator the caller dispatches
 *  on. Never throws — every failure mode is explicit. */
export async function readClipboardImage(
  opts: { readonly maxBytes?: number } = {},
): Promise<ClipboardReadResult> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  switch (process.platform) {
    case 'darwin':
      return readMacOS(maxBytes);
    case 'linux':
      return readLinux(maxBytes);
    case 'win32':
      return readWindows(maxBytes);
    default:
      return {
        ok: false,
        failure: { kind: 'unsupported_platform', platform: process.platform },
      };
  }
}

/** Show an install hint at most once per session per tool. The
 *  Submit panel uses this to avoid spamming the user with the same
 *  toast on every Ctrl+V when their setup is missing the tool. */
export function shouldShowHintOnce(toolKey: string): boolean {
  if (hintShownFor.has(toolKey)) return false;
  hintShownFor.add(toolKey);
  return true;
}

/** Test-only: clear the hint cache between cases. */
export function _resetHintCacheForTests(): void {
  hintShownFor.clear();
}
