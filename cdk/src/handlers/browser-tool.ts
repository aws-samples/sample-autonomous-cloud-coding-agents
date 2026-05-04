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

import { BedrockAgentCoreClient, StartBrowserSessionCommand, StopBrowserSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { PutObjectCommand, S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import WebSocket from 'ws';

const agentCoreClient = new BedrockAgentCoreClient({});
const s3Client = new S3Client({});

const BROWSER_ID = process.env.BROWSER_ID!;
const SCREENSHOT_BUCKET_NAME = process.env.SCREENSHOT_BUCKET_NAME!;

const PAGE_LOAD_TIMEOUT_MS = 30_000;
// Actual validity is bounded by the signing credential lifetime (IAM role session).
const PRESIGNED_URL_EXPIRES_IN = 604_800; // 7 days

interface BrowserToolEvent {
  action: 'screenshot';
  url: string;
  taskId?: string;
}

type BrowserToolResponse =
  | { status: 'success'; screenshotS3Key: string; presignedUrl: string }
  | { status: 'error'; error: string };

interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

const ALLOWED_DOMAIN = 'github.com';

const RFC1918_PATTERNS = [
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}/,
  /^192\.168\.\d{1,3}\.\d{1,3}/,
  /^169\.254\.\d{1,3}\.\d{1,3}/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}/,
];

export function validateUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:') {
    return 'Only HTTPS URLs are allowed';
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname === '[::1]') {
    return 'Localhost URLs are not allowed';
  }

  for (const pattern of RFC1918_PATTERNS) {
    if (pattern.test(hostname)) {
      return 'Private/internal IP addresses are not allowed';
    }
  }

  if (hostname !== ALLOWED_DOMAIN && !hostname.endsWith(`.${ALLOWED_DOMAIN}`)) {
    return `Only ${ALLOWED_DOMAIN} URLs are allowed`;
  }

  return null;
}

function sendCdpCommand(ws: WebSocket, id: number, method: string, params?: Record<string, unknown>): void {
  ws.send(JSON.stringify({ id, method, params }));
}

function waitForCdpResponse(ws: WebSocket, expectedId: number, timeoutMs: number): Promise<CdpResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP response timeout for id ${expectedId}`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.Data) => {
      let msg: CdpResponse & { method?: string };
      try {
        msg = JSON.parse(String(data)) as CdpResponse & { method?: string };
      } catch {
        return; // Skip unparseable messages
      }
      if (msg.id === expectedId) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        if (msg.error) {
          reject(new Error(`CDP error: ${msg.error.message}`));
        } else {
          resolve(msg);
        }
      }
    };
    ws.on('message', onMessage);
  });
}

function waitForCdpEvent(ws: WebSocket, eventName: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`CDP event timeout waiting for ${eventName}`));
    }, timeoutMs);

    const onMessage = (data: WebSocket.Data) => {
      let msg: { method?: string };
      try {
        msg = JSON.parse(String(data)) as { method?: string };
      } catch {
        return; // Skip unparseable messages
      }
      if (msg.method === eventName) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve();
      }
    };
    ws.on('message', onMessage);
  });
}

export async function handler(event: BrowserToolEvent): Promise<BrowserToolResponse> {
  if (event.action !== 'screenshot') {
    return { status: 'error', error: `Unsupported action: ${event.action}` };
  }

  const urlError = validateUrl(event.url);
  if (urlError) {
    return { status: 'error', error: `URL rejected: ${urlError}` };
  }

  let sessionId: string | undefined;

  try {
    // Step 1: Start browser session
    const startResponse = await agentCoreClient.send(new StartBrowserSessionCommand({
      browserIdentifier: BROWSER_ID,
      name: `screenshot-${Date.now()}`,
    }));

    if (!startResponse.sessionId) {
      throw new Error('StartBrowserSession did not return a sessionId');
    }
    sessionId = startResponse.sessionId;

    if (!startResponse.streams?.automationStream?.streamEndpoint) {
      throw new Error('StartBrowserSession did not return a stream endpoint');
    }
    const streamEndpoint = startResponse.streams.automationStream.streamEndpoint;

    // Step 2: Connect WebSocket to CDP endpoint
    const ws = new WebSocket(streamEndpoint);

    ws.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('WebSocket error:', err);
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), 10_000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });

    try {
      // Step 3: Enable Page domain
      sendCdpCommand(ws, 1, 'Page.enable');
      await waitForCdpResponse(ws, 1, 10_000);

      // Step 4: Navigate to URL
      const loadPromise = waitForCdpEvent(ws, 'Page.loadEventFired', PAGE_LOAD_TIMEOUT_MS);
      sendCdpCommand(ws, 2, 'Page.navigate', { url: event.url });
      await waitForCdpResponse(ws, 2, 10_000);

      // Step 5: Wait for page load
      await loadPromise;

      // Step 6: Capture screenshot
      sendCdpCommand(ws, 3, 'Page.captureScreenshot', { format: 'png' });
      const screenshotResponse = await waitForCdpResponse(ws, 3, 15_000);
      if (!screenshotResponse.result?.data) {
        throw new Error('Screenshot response did not contain image data');
      }
      const base64Data = screenshotResponse.result.data as string;

      // Step 7: Upload to S3
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const sanitizedTaskId = (event.taskId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
      const s3Key = `screenshots/${sanitizedTaskId}/${timestamp}.png`;

      await s3Client.send(new PutObjectCommand({
        Bucket: SCREENSHOT_BUCKET_NAME,
        Key: s3Key,
        Body: Buffer.from(base64Data, 'base64'),
        ContentType: 'image/png',
      }));

      // Step 8: Generate presigned URL
      const presignedUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: SCREENSHOT_BUCKET_NAME, Key: s3Key }),
        { expiresIn: PRESIGNED_URL_EXPIRES_IN },
      );

      return {
        status: 'success',
        screenshotS3Key: s3Key,
        presignedUrl,
      };
    } finally {
      ws.close();
    }
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Step 9: Stop browser session
    if (sessionId) {
      try {
        await agentCoreClient.send(new StopBrowserSessionCommand({
          browserIdentifier: BROWSER_ID,
          sessionId,
        }));
      } catch (cleanupErr) {
        // eslint-disable-next-line no-console
        console.error('Failed to stop browser session:', sessionId, cleanupErr);
      }
    }
  }
}
