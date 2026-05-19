/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 */

/**
 * Cross-platform clipboard image reader.
 *
 * Strategy: spawn the platform's native clipboard tool and capture
 * raw bytes from stdout. We deliberately do NOT bundle a native
 * Node addon — every TUI tool we surveyed (Claude Code, lazygit,
 * tig) uses the same shell-spawn pattern. It's debuggable, has
 * zero install footprint, and the system tools are battle-tested
 * at the OS level.
 *
 * Per-platform tools:
 *   macOS    pngpaste -          (brew install pngpaste)
 *            pbpaste -Prefer png  (built-in fallback)
 *   Linux    xclip -selection clipboard -t image/png -o   (X11)
 *            wl-paste --type image/png                    (Wayland)
 *   Windows  powershell.exe + System.Windows.Forms.Clipboard
 *
 * The user installs the tool themselves; missing tools fail
 * gracefully with a one-time install hint cached in module state.
 *
 * Magic bytes:
 *   PNG  89 50 4E 47 0D 0A 1A 0A
 *   JPEG FF D8 FF
 *   GIF  47 49 46 38
 *
 * We sniff so the caller knows the correct content_type even when
 * the tool (e.g. `pbpaste`) returns "anything" without a header.
 */

import { spawn } from 'node:child_process';

/** Caller-facing payload for an attached image. */
export interface ClipboardImage {
  /** Raw image bytes. */
  readonly buffer: Buffer;
  /** MIME type, set from magic-byte sniff. */
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif';
  /** Convenience for the API contract — base64 of `buffer`. */
  readonly base64: string;
  /** Byte length, surfaced so the panel can render KB hints. */
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

/** Default per-image cap. Matches Claude Code's documented limit. */
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Module-level cache so install hints surface once per session
 *  rather than on every Ctrl+V. Keyed on tool name. */
const hintShownFor = new Set<string>();

/** Sniff the leading bytes for a recognized image format. Returns
 *  null when the buffer doesn't match any. */
function sniffMediaType(buf: Buffer): ClipboardImage['mediaType'] | null {
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
  return null;
}

interface SpawnResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly toolMissing: boolean;
}

/** Async wrapper around spawn that captures stdout as a Buffer.
 *  Test seam: re-export points to this so tests can stub it.
 *
 *  Buffers all stdout into memory. The caller is responsible for
 *  size-policy decisions (`toImage`'s `maxBytes` check). A 2s
 *  timeout protects against a runaway process; for clipboard
 *  tools the actual data volume is bounded by the OS clipboard
 *  contents. */
export async function spawnAndCollect(
  cmd: string,
  args: readonly string[],
  opts: { readonly stdin?: string; readonly timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let stderr = '';
    let killed = false;

    const timeoutMs = opts.timeoutMs ?? 2_000;
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
      // ENOENT = tool not on PATH. We surface this distinctly so
      // the caller can show an install hint.
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

/** Convert a raw byte buffer + sniffed media type into a
 *  caller-facing ClipboardImage, applying the size cap. */
function toImage(buf: Buffer, maxBytes: number): ClipboardReadResult {
  if (buf.length === 0) {
    return { ok: false, failure: { kind: 'empty' } };
  }
  const mediaType = sniffMediaType(buf);
  if (mediaType === null) {
    return { ok: false, failure: { kind: 'not_image' } };
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

async function readMacOS(maxBytes: number): Promise<ClipboardReadResult> {
  // First try `pngpaste -` — strict contract: exit 0 = bytes, exit 1
  // = no image. If pngpaste isn't installed (ENOENT), fall back to
  // `pbpaste -Prefer png` and rely on magic-byte sniffing because
  // pbpaste doesn't distinguish image-vs-text via exit code.
  const png = await spawnAndCollect('pngpaste', ['-']);
  if (!png.toolMissing) {
    if (png.exitCode === 0) {
      return toImage(png.stdout, maxBytes);
    }
    // pngpaste ran but had no image. Don't fall through to pbpaste —
    // pngpaste is authoritative when present.
    return { ok: false, failure: { kind: 'empty' } };
  }

  // pngpaste missing — try pbpaste fallback.
  const pbp = await spawnAndCollect('pbpaste', ['-Prefer', 'png']);
  if (pbp.toolMissing) {
    // pbpaste is built-in to macOS. If we land here something is
    // really wrong; surface the install hint anyway.
    return {
      ok: false,
      failure: {
        kind: 'tool_missing',
        platform: 'darwin',
        hint: 'Install pngpaste for clipboard image paste:\n  brew install pngpaste',
      },
    };
  }
  if (pbp.exitCode !== 0 || pbp.stdout.length === 0) {
    return { ok: false, failure: { kind: 'empty' } };
  }
  return toImage(pbp.stdout, maxBytes);
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
  const cmd = isWayland ? 'wl-paste' : 'xclip';
  const args = isWayland
    ? ['--type', 'image/png']
    : ['-selection', 'clipboard', '-t', 'image/png', '-o'];
  const result = await spawnAndCollect(cmd, args);
  if (result.toolMissing) {
    return {
      ok: false,
      failure: {
        kind: 'tool_missing',
        platform: 'linux',
        hint: isWayland
          ? 'Install wl-clipboard for image paste:\n  sudo apt install wl-clipboard'
          : 'Install xclip for image paste:\n  sudo apt install xclip',
      },
    };
  }
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    return { ok: false, failure: { kind: 'empty' } };
  }
  return toImage(result.stdout, maxBytes);
}

const WIN_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($null -eq $img) { exit 1 }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())
`.trim();

async function readWindows(maxBytes: number): Promise<ClipboardReadResult> {
  // Use powershell.exe (Windows PowerShell 5.1) explicitly. Some
  // PowerShell Core (`pwsh`) installs lack System.Windows.Forms.
  // From WSL the same `powershell.exe` binary is reachable on PATH
  // via /mnt/c interop, so no platform branch needed here.
  const result = await spawnAndCollect(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', WIN_PS_SCRIPT],
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
  if (result.exitCode !== 0 || result.stdout.length === 0) {
    return { ok: false, failure: { kind: 'empty' } };
  }
  // PowerShell's Write-Output in -Command mode emits the base64
  // string with trailing CRLF + possible UTF-8 BOM. Strip both.
  let raw = result.stdout.toString('utf8').replace(/^﻿/, '').trim();
  raw = raw.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/=]+$/.test(raw)) {
    return {
      ok: false,
      failure: { kind: 'error', message: 'PowerShell returned non-base64 output' },
    };
  }
  const buf = Buffer.from(raw, 'base64');
  return toImage(buf, maxBytes);
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
