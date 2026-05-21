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

/**
 * URL attachment resolution: SSRF-safe fetch, screen, and upload to S3.
 *
 * During context hydration, URL attachments (type: 'url', screening: pending)
 * are fetched from their source URLs with full SSRF protection:
 *   1. DNS resolution pinning (resolve, validate IP, connect to resolved IP)
 *   2. Private IP range blocking
 *   3. Redirect validation (re-check IPs after each redirect, max 2)
 *   4. Timeout and size limits
 *
 * Fetched content is screened through the same Bedrock Guardrail pipeline as
 * inline/presigned attachments, then uploaded to S3.
 *
 * Tests: cdk/test/handlers/shared/resolve-url-attachments.test.ts
 */

import { createHash } from 'crypto';
import { promises as dns } from 'dns';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './attachment-screening';
import { AttachmentResolutionError } from './context-hydration';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { logger } from './logger';
import { createAttachmentRecord, type AttachmentRecord } from './types';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from '../../constructs/attachments-bucket';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const URL_FETCH_TIMEOUT_MS = 10_000;
const MAX_FETCH_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_REDIRECTS = 2;

/** RFC 1918 + link-local + loopback + CGN + IPv6 equivalents + IPv4-mapped IPv6. */
const PRIVATE_IP_RANGES = [
  // IPv4
  { prefix: '10.', mask: null },
  {
    prefix: '172.',
    mask: (ip: string) => {
      const second = parseInt(ip.split('.')[1], 10);
      return second >= 16 && second <= 31;
    },
  },
  { prefix: '192.168.', mask: null },
  { prefix: '169.254.', mask: null },
  { prefix: '127.', mask: null },
  { prefix: '0.', mask: null },
  { prefix: '100.64.', mask: null }, // CGN / Shared Address Space (RFC 6598)
  // IPv6
  { prefix: '::1', mask: null },
  { prefix: 'fc', mask: null },
  { prefix: 'fd', mask: null },
  { prefix: 'fe80:', mask: null },
  // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) — prevents SSRF bypass
  // by attackers returning mapped addresses from DNS that embed private IPv4.
  { prefix: '::ffff:', mask: null },
  { prefix: '0:0:0:0:0:ffff:', mask: null },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveUrlAttachmentsOptions {
  readonly s3Client: S3Client;
  readonly bucketName: string;
  readonly screeningConfig: ScreeningConfig;
  readonly githubToken?: string;
  readonly githubInstallationDomain?: string;
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * Check if an IP address belongs to a private/internal range.
 * Returns a reason string if private, undefined if public.
 */
function isPrivateIp(ip: string): string | undefined {
  const normalized = ip.toLowerCase();

  for (const range of PRIVATE_IP_RANGES) {
    if (typeof range.mask === 'function') {
      if (normalized.startsWith(range.prefix) && range.mask(normalized)) {
        return `IP ${ip} is in private range (${range.prefix}x)`;
      }
    } else if (normalized.startsWith(range.prefix) || normalized === range.prefix) {
      return `IP ${ip} is in private/reserved range`;
    }
  }

  return undefined;
}

/**
 * Resolve DNS and validate the resolved IP is not in a private range.
 * Returns the resolved IP address for connection pinning.
 *
 * DNS resolution pinning prevents the DNS rebinding attack:
 *   1. Attacker's DNS returns a public IP on first lookup (passes validation)
 *   2. Attacker's DNS returns a private IP on second lookup (reaches internal services)
 *   3. By resolving once and pinning the connection to that IP, we eliminate the TOCTOU window
 */
async function resolveAndValidate(hostname: string): Promise<string> {
  let addresses: string[];

  try {
    // Try IPv4 first (more common for HTTP endpoints)
    addresses = await dns.resolve4(hostname);
  } catch (ipv4Err) {
    try {
      addresses = await dns.resolve6(hostname);
    } catch (ipv6Err) {
      throw new AttachmentResolutionError(
        `DNS resolution failed for '${hostname}'. Check that the URL is correct and the server is reachable.`,
        { cause: new AggregateError([ipv4Err, ipv6Err], `Both IPv4 and IPv6 resolution failed for '${hostname}'`) },
      );
    }
  }

  if (addresses.length === 0) {
    throw new AttachmentResolutionError(
      `DNS resolution returned no addresses for '${hostname}'.`,
    );
  }

  // Validate all resolved IPs — reject if any is private
  for (const ip of addresses) {
    const privateReason = isPrivateIp(ip);
    if (privateReason) {
      throw new AttachmentResolutionError(
        `URL attachment blocked: ${privateReason}. ` +
        'URL attachments cannot target private or internal network addresses.',
      );
    }
  }

  // Return the first valid IP for connection pinning
  return addresses[0];
}

/**
 * Build a pinned URL that connects to the resolved IP while preserving
 * the original path, query, and port. The Host header carries the real
 * hostname for TLS SNI / virtual-host routing.
 */
function buildPinnedUrl(originalUrl: URL, resolvedIp: string): URL {
  const pinned = new URL(originalUrl.toString());
  // For IPv6 addresses, wrap in brackets for URL hostname
  pinned.hostname = resolvedIp.includes(':') ? `[${resolvedIp}]` : resolvedIp;
  return pinned;
}

/**
 * Fetch a URL with SSRF protections: DNS pinning, private IP rejection,
 * redirect validation, timeout, and size limit.
 *
 * DNS pinning: we resolve the hostname, validate the IP is public, then
 * rewrite the fetch URL to connect directly to that IP (with the original
 * Host header for TLS SNI). This closes the DNS rebinding TOCTOU window.
 */
async function ssrfSafeFetch(
  url: string,
  options?: { githubToken?: string; githubInstallationDomain?: string },
): Promise<{ content: Buffer; finalContentType: string }> {
  const parsedUrl = new URL(url);

  if (parsedUrl.protocol !== 'https:') {
    throw new AttachmentResolutionError(
      `URL attachment must use HTTPS. Got: ${parsedUrl.protocol}`,
    );
  }

  // Resolve DNS and validate IP before connecting
  const resolvedIp = await resolveAndValidate(parsedUrl.hostname);

  // Build the pinned URL that connects to the validated IP
  let pinnedUrl = buildPinnedUrl(parsedUrl, resolvedIp);

  // Determine if we should send auth headers (only to GitHub)
  const headers: Record<string, string> = {
    'Host': parsedUrl.hostname,
    'User-Agent': 'ABCA-Attachment-Fetcher/1.0',
  };

  if (options?.githubToken && isGitHubUrl(parsedUrl.hostname, options.githubInstallationDomain)) {
    headers.Authorization = `Bearer ${options.githubToken}`;
  }

  let currentUrl = url;
  let redirectCount = 0;
  let response: Response;

  // Fetch with redirect following (re-validate each redirect target)
  while (true) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);

    try {
      // Use pinnedUrl (resolved IP) for the actual connection, with Host header
      // preserving the real hostname for TLS SNI and virtual-host routing.
      response = await fetch(pinnedUrl.toString(), {
        headers,
        signal: controller.signal,
        redirect: 'manual', // Handle redirects manually for IP re-validation
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new AttachmentResolutionError(
          `URL attachment fetch timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s: ${url}`,
        );
      }
      throw new AttachmentResolutionError(
        `URL attachment fetch failed: ${err.message ?? String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    // Handle redirects
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        throw new AttachmentResolutionError(
          `URL attachment redirect (${response.status}) had no Location header.`,
        );
      }

      redirectCount++;
      if (redirectCount > MAX_REDIRECTS) {
        throw new AttachmentResolutionError(
          `URL attachment exceeded maximum redirects (${MAX_REDIRECTS}): ${url}`,
        );
      }

      // Re-validate the redirect target
      const redirectUrl = new URL(location, currentUrl);
      if (redirectUrl.protocol !== 'https:') {
        throw new AttachmentResolutionError(
          `URL attachment redirect to non-HTTPS URL blocked: ${redirectUrl.protocol}`,
        );
      }
      const redirectIp = await resolveAndValidate(redirectUrl.hostname);
      currentUrl = redirectUrl.toString();

      // Pin the redirect target to its resolved IP
      pinnedUrl = buildPinnedUrl(redirectUrl, redirectIp);

      // Don't send auth headers to non-GitHub redirect targets
      if (!isGitHubUrl(redirectUrl.hostname, options?.githubInstallationDomain)) {
        delete headers.Authorization;
      }
      headers.Host = redirectUrl.hostname;
      continue;
    }

    break;
  }

  if (!response!.ok) {
    throw new AttachmentResolutionError(
      `URL attachment fetch failed with status ${response!.status}: ${url}`,
    );
  }

  // Stream response with size limit enforcement
  const contentType = response!.headers.get('content-type') ?? 'application/octet-stream';
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  const reader = response!.body?.getReader();
  if (!reader) {
    throw new AttachmentResolutionError(
      `URL attachment response has no body: ${url}`,
    );
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.length;
    if (totalBytes > MAX_FETCH_SIZE_BYTES) {
      await reader.cancel();
      throw new AttachmentResolutionError(
        `URL attachment exceeds ${MAX_FETCH_SIZE_BYTES / (1024 * 1024)} MB size limit: ${url}`,
      );
    }
    chunks.push(Buffer.from(value));
  }

  return {
    content: Buffer.concat(chunks),
    finalContentType: contentType.split(';')[0].trim(),
  };
}

function isGitHubUrl(hostname: string, installationDomain?: string): boolean {
  const githubHosts = ['github.com', 'raw.githubusercontent.com', 'api.github.com'];
  if (installationDomain) githubHosts.push(installationDomain);
  const lower = hostname.toLowerCase();
  return githubHosts.some(h => lower === h || lower.endsWith(`.${h}`));
}

// ---------------------------------------------------------------------------
// Main resolution function
// ---------------------------------------------------------------------------

/**
 * Resolve URL attachments: fetch, screen, upload to S3.
 *
 * Takes the task's attachment records (from DynamoDB), resolves any with
 * screening.status === 'pending' and type === 'url', and returns the full
 * updated attachment list.
 *
 * Throws AttachmentResolutionError if any URL attachment cannot be resolved.
 * The caller (orchestrator) should let this propagate to fail the task.
 */
export async function resolveUrlAttachments(
  attachments: AttachmentRecord[],
  taskId: string,
  userId: string,
  options: ResolveUrlAttachmentsOptions,
): Promise<AttachmentRecord[]> {
  const pendingUrls = attachments.filter(
    att => att.type === 'url' && att.screening.status === 'pending',
  );

  if (pendingUrls.length === 0) {
    return attachments;
  }

  logger.info('Resolving URL attachments', {
    task_id: taskId,
    count: pendingUrls.length,
  });

  const resolved = new Map<string, AttachmentRecord>();

  for (const att of pendingUrls) {
    if (!att.source_url) {
      throw new AttachmentResolutionError(
        `URL attachment '${att.filename}' has no source_url.`,
      );
    }

    // Fetch with SSRF protection
    const { content, finalContentType } = await ssrfSafeFetch(att.source_url, {
      githubToken: options.githubToken,
    });

    logger.info('URL attachment fetched', {
      attachment_id: att.attachment_id,
      filename: att.filename,
      size_bytes: content.length,
      content_type: finalContentType,
    });

    // Determine if this is an image or file based on content type
    const isImage = finalContentType.startsWith('image/');
    const resolvedContentType = att.content_type || finalContentType;

    // Screen the fetched content
    let screenResult;
    try {
      screenResult = isImage
        ? await screenImage(content, resolvedContentType, att.filename, options.screeningConfig)
        : await screenTextFile(content, resolvedContentType, att.filename, options.screeningConfig);
    } catch (err) {
      if (err instanceof AttachmentScreeningError) {
        throw new AttachmentResolutionError(
          `URL attachment '${att.filename}' was blocked by content screening: ${err.message}`,
          { cause: err },
        );
      }
      throw new AttachmentResolutionError(
        `URL attachment '${att.filename}' could not be screened: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (screenResult.screening.status === 'blocked') {
      throw new AttachmentResolutionError(
        `URL attachment '${att.filename}' was blocked by content policy: ${screenResult.screening.categories.join(', ')}`,
      );
    }

    // Upload screened content to S3
    const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${userId}/${taskId}/${att.attachment_id}/${att.filename}`;
    const putResult = await options.s3Client.send(new PutObjectCommand({
      Bucket: options.bucketName,
      Key: s3Key,
      Body: screenResult.content,
      ContentType: resolvedContentType,
    }));

    // Compute checksum
    const checksum = createHash('sha256').update(screenResult.content).digest('hex');

    // Estimate token cost for images
    let tokenEstimate: number | undefined;
    if (isImage) {
      tokenEstimate = await estimateImageTokensFromBuffer(screenResult.content);
    }

    resolved.set(att.attachment_id, createAttachmentRecord({
      attachment_id: att.attachment_id,
      type: att.type,
      content_type: resolvedContentType,
      filename: att.filename,
      s3_key: s3Key,
      s3_version_id: putResult.VersionId ?? 'unversioned',
      size_bytes: screenResult.content.length,
      screening: { status: 'passed', screened_at: new Date().toISOString() },
      source_url: att.source_url,
      checksum_sha256: checksum,
      ...(tokenEstimate !== undefined && { token_estimate: tokenEstimate }),
    }));

    logger.info('URL attachment resolved and stored', {
      attachment_id: att.attachment_id,
      filename: att.filename,
      s3_key: s3Key,
    });
  }

  // Merge resolved records back into the full attachment list
  return attachments.map(att => resolved.get(att.attachment_id) ?? att);
}
