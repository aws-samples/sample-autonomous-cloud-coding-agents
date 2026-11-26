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

import { promises as dns } from 'dns';
import type { IncomingHttpHeaders } from 'http';
import * as https from 'https';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { screenImage, screenTextFile, AttachmentScreeningError, type ScreeningConfig } from './attachment-screening';
import { AttachmentResolutionError } from './context-hydration';
import { estimateImageTokensFromBuffer } from './image-tokens';
import { logger } from './logger';
import { ATTACHMENT_OBJECT_KEY_PREFIX } from './storage-names';
import { createAttachmentRecord, type AttachmentRecord } from './types';
import { isAllowedMimeType, isPrivateIp, MAX_ATTACHMENT_SIZE_BYTES, MAX_TOTAL_ATTACHMENT_SIZE_BYTES, validateMagicBytes } from './validation';

const URL_FETCH_TIMEOUT_MS = 10_000;
const URL_RESOLUTION_BUDGET_MS = 30_000;
const MAX_REDIRECTS = 2;

const HTTP_REDIRECT_STATUS_MIN = 300;

const HTTP_REDIRECT_STATUS_MAX = 400;

export interface ResolveUrlAttachmentsOptions {
  readonly s3Client: S3Client;
  readonly bucketName: string;
  readonly screeningConfig: ScreeningConfig;
  readonly githubToken?: string;
  readonly githubInstallationDomain?: string;
}

interface PinnedResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

async function resolveAndValidate(hostname: string): Promise<string> {
  let addresses: string[];

  try {
    addresses = await dns.resolve4(hostname);
  } catch (ipv4Err: any) {
    const dnsNoRecordCodes = ['ENODATA', 'ENOTFOUND', 'NODATA'];
    if (!dnsNoRecordCodes.includes(ipv4Err?.code)) {
      try {
        addresses = await dns.resolve6(hostname);
      } catch (ipv6Err) {
        throw new AttachmentResolutionError(
          `DNS resolution failed for '${hostname}': ${ipv4Err?.code ?? ipv4Err?.message ?? 'unknown error'}`,
          { cause: new AggregateError([ipv4Err, ipv6Err], `Both IPv4 and IPv6 resolution failed for '${hostname}'`) },
        );
      }
    } else {
      try {
        addresses = await dns.resolve6(hostname);
      } catch (ipv6Err) {
        throw new AttachmentResolutionError(
          `DNS resolution failed for '${hostname}'. Check that the URL is correct and the server is reachable.`,
          { cause: new AggregateError([ipv4Err, ipv6Err], `Both IPv4 and IPv6 resolution failed for '${hostname}'`) },
        );
      }
    }
  }

  if (addresses.length === 0) {
    throw new AttachmentResolutionError(
      `DNS resolution returned no addresses for '${hostname}'.`,
    );
  }

  for (const ip of addresses) {
    const privateReason = isPrivateIp(ip);
    if (privateReason) {
      throw new AttachmentResolutionError(
        `URL attachment blocked: ${privateReason}. ` +
        'URL attachments cannot target private or internal network addresses.',
      );
    }
  }

  return addresses[0];
}

function buildPinnedUrl(originalUrl: URL, resolvedIp: string): URL {
  const pinned = new URL(originalUrl.toString());
  pinned.hostname = resolvedIp.includes(':') ? `[${resolvedIp}]` : resolvedIp;
  return pinned;
}

/**
 * Global fetch() uses the URL hostname for SNI: when connecting to a resolved IP,
 * the certificate check fails unless servername is overridden.
 * The fetch Response constructor throws for 204, 205, 304 and any status outside
 * 200-599, and a throw inside the 'end' listener is an uncaught exception, not a
 * rejection.
 */
async function pinnedHttpsRequest(
  pinnedUrl: URL,
  originalHostname: string,
  options: { headers: Record<string, string>; signal: AbortSignal },
): Promise<PinnedResponse> {
  return new Promise<PinnedResponse>((resolve, reject) => {
    const hostname = pinnedUrl.hostname.replace(/^\[|\]$/g, '');
    const port = Number(pinnedUrl.port || '443');

    const agent = new https.Agent({
      servername: originalHostname,
    });

    const req = https.request(
      {
        hostname,
        port,
        path: pinnedUrl.pathname + pinnedUrl.search,
        method: 'GET',
        headers: options.headers,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > MAX_ATTACHMENT_SIZE_BYTES) {
            res.destroy();
            agent.destroy();
            reject(new Error(`Response exceeds ${MAX_ATTACHMENT_SIZE_BYTES} byte size limit`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 500, headers: res.headers, body: Buffer.concat(chunks) });
          agent.destroy();
        });
        res.on('error', (err) => {
          agent.destroy();
          reject(err);
        });
      },
    );

    req.on('error', (err) => {
      agent.destroy();
      reject(err);
    });

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        req.destroy();
        agent.destroy();
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    }

    req.end();
  });
}

async function ssrfSafeFetch(
  url: string,
  deadline: number,
  options?: { githubToken?: string; githubInstallationDomain?: string },
): Promise<{ content: Buffer; finalContentType: string }> {
  const parsedUrl = new URL(url);

  if (parsedUrl.protocol !== 'https:') {
    throw new AttachmentResolutionError(
      `URL attachment must use HTTPS. Got: ${parsedUrl.protocol}`,
    );
  }

  const resolvedIp = await resolveAndValidate(parsedUrl.hostname);

  let pinnedUrl = buildPinnedUrl(parsedUrl, resolvedIp);

  const headers: Record<string, string> = {
    'Host': parsedUrl.hostname,
    'User-Agent': 'ABCA-Attachment-Fetcher/1.0',
  };

  if (options?.githubToken && isGitHubUrl(parsedUrl.hostname, options.githubInstallationDomain)) {
    headers.Authorization = `Bearer ${options.githubToken}`;
  }

  let currentUrl = url;
  let currentHostname = parsedUrl.hostname;
  let redirectCount = 0;
  let response: PinnedResponse;
  const outOfTime = `URL attachments could not be fetched and screened within ${URL_RESOLUTION_BUDGET_MS / 1000}s (stopped at ${url}).`;

  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new AttachmentResolutionError(outOfTime);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(URL_FETCH_TIMEOUT_MS, remainingMs));

    try {
      response = await pinnedHttpsRequest(pinnedUrl, currentHostname, {
        headers,
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new AttachmentResolutionError(
          remainingMs < URL_FETCH_TIMEOUT_MS
            ? outOfTime
            : `URL attachment fetch timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s: ${url}`,
        );
      }
      throw new AttachmentResolutionError(
        `URL attachment fetch failed: ${err.message ?? String(err)}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= HTTP_REDIRECT_STATUS_MIN && response.status < HTTP_REDIRECT_STATUS_MAX) {
      const location = response.headers.location;
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

      const redirectUrl = new URL(location, currentUrl);
      if (redirectUrl.protocol !== 'https:') {
        throw new AttachmentResolutionError(
          `URL attachment redirect to non-HTTPS URL blocked: ${redirectUrl.protocol}`,
        );
      }
      const redirectIp = await resolveAndValidate(redirectUrl.hostname);
      currentUrl = redirectUrl.toString();
      currentHostname = redirectUrl.hostname;

      pinnedUrl = buildPinnedUrl(redirectUrl, redirectIp);

      if (!isGitHubUrl(redirectUrl.hostname, options?.githubInstallationDomain)) {
        delete headers.Authorization;
      }
      headers.Host = redirectUrl.hostname;
      continue;
    }

    break;
  }

  if (response.status < 200 || response.status >= HTTP_REDIRECT_STATUS_MIN) {
    throw new AttachmentResolutionError(
      `URL attachment fetch failed with status ${response.status}: ${url}`,
    );
  }

  if (response.body.length === 0) {
    throw new AttachmentResolutionError(
      `URL attachment response has no body (status ${response.status}): ${url}`,
    );
  }

  const contentType = response.headers['content-type'] || 'application/octet-stream';

  return {
    content: response.body,
    finalContentType: contentType.split(';')[0].trim(),
  };
}

function isGitHubUrl(hostname: string, installationDomain?: string): boolean {
  const githubHosts = ['github.com', 'raw.githubusercontent.com', 'api.github.com'];
  if (installationDomain) githubHosts.push(installationDomain);
  const lower = hostname.toLowerCase();
  return githubHosts.some(h => lower === h || lower.endsWith(`.${h}`));
}

/**
 * Resolve URL attachments: fetch, screen, upload to S3.
 *
 * Takes the task's attachment records, resolves any with
 * screening.status === 'pending' and type === 'url', and returns the full
 * updated attachment list.
 *
 * Throws AttachmentResolutionError if any URL attachment cannot be resolved.
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
  const deadline = Date.now() + URL_RESOLUTION_BUDGET_MS;

  let totalBytes = attachments.reduce((sum, a) => sum + (a.size_bytes ?? 0), 0);

  for (const att of pendingUrls) {
    if (!att.source_url) {
      throw new AttachmentResolutionError(
        `URL attachment '${att.filename}' has no source_url.`,
      );
    }

    const { content, finalContentType } = await ssrfSafeFetch(att.source_url, deadline, {
      githubToken: options.githubToken,
    });

    logger.info('URL attachment fetched', {
      attachment_id: att.attachment_id,
      filename: att.filename,
      size_bytes: content.length,
      content_type: finalContentType,
    });

    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_ATTACHMENT_SIZE_BYTES) {
      throw new AttachmentResolutionError(
        `Combined attachment size exceeds the ${MAX_TOTAL_ATTACHMENT_SIZE_BYTES}-byte task limit.`,
      );
    }

    const resolvedContentType = (att.content_type && att.content_type !== 'application/octet-stream')
      ? att.content_type
      : finalContentType;
    const isImage = resolvedContentType.startsWith('image/');

    const attachmentType = isImage ? 'image' : 'file';
    if (!isAllowedMimeType(resolvedContentType, attachmentType)) {
      throw new AttachmentResolutionError(
        `URL attachment '${att.filename}' returned unsupported content type '${resolvedContentType}'. ` +
        'Only supported image and text file types are allowed.',
      );
    }

    if (!validateMagicBytes(content, resolvedContentType)) {
      throw new AttachmentResolutionError(
        `URL attachment '${att.filename}' content does not match declared type '${resolvedContentType}'. ` +
        'The file may be corrupt or masquerading as a different type.',
      );
    }

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

    const s3Key = `${ATTACHMENT_OBJECT_KEY_PREFIX}${userId}/${taskId}/${att.attachment_id}/${att.filename}`;
    let putResult;
    try {
      putResult = await options.s3Client.send(new PutObjectCommand({
        Bucket: options.bucketName,
        Key: s3Key,
        Body: screenResult.content,
        ContentType: resolvedContentType,
      }));
    } catch (s3Err) {
      logger.error('S3 upload failed for URL attachment', {
        attachment_id: att.attachment_id,
        filename: att.filename,
        s3_key: s3Key,
        error: s3Err instanceof Error ? s3Err.message : String(s3Err),
        metric_type: 'url_attachment_upload_failure',
      });
      throw new AttachmentResolutionError(
        `URL attachment '${att.filename}' could not be stored. Please try again later.`,
        { cause: s3Err },
      );
    }

    const checksum = screenResult.checksum;

    let tokenEstimate: number | undefined;
    if (isImage) {
      tokenEstimate = estimateImageTokensFromBuffer(screenResult.content, resolvedContentType);
    }

    resolved.set(att.attachment_id, createAttachmentRecord({
      attachment_id: att.attachment_id,
      type: isImage ? 'image' : 'file',
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

  return attachments.map(att => resolved.get(att.attachment_id) ?? att);
}
