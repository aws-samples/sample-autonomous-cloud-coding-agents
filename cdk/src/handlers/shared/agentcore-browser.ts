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

import { Sha256 } from '@aws-crypto/sha256-js';
import {
  BedrockAgentCoreClient,
  StartBrowserSessionCommand,
  StopBrowserSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';
import WebSocket, { type RawData } from 'ws';
import { logger } from './logger';
import { makeClient } from './ua';

const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

/** AgentCore Browser's AWS-managed default browser: usable without `CreateBrowser`. */
const AWS_BROWSER_IDENTIFIER = 'aws.browser.v1';

const DEFAULT_TIMEOUT_MS = 60_000;

const PAGE_SETTLE_WAIT_MS = 2000;

const HTTP_STATUS_SUCCESS_MIN = 200;

const HTTP_STATUS_REDIRECT_MIN = 300;

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

/**
 * Capture a full-page PNG screenshot of `url` via AgentCore Browser.
 *
 * @param url The URL to navigate to and screenshot.
 * @param opts.timeoutMs Override the default 60s budget.
 * @returns Raw PNG bytes (NOT base64-wrapped) ready for S3.PutObject.
 */
export async function captureScreenshot(url: string, opts: { timeoutMs?: number } = {}): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = makeClient(BedrockAgentCoreClient, { region: REGION });

  const startResp = await client.send(new StartBrowserSessionCommand({
    browserIdentifier: AWS_BROWSER_IDENTIFIER,
    name: `bgagent-screenshot-${Date.now()}`,
  }));
  const sessionId = startResp.sessionId;
  const automationEndpoint = startResp.streams?.automationStream?.streamEndpoint;
  if (!sessionId || !automationEndpoint) {
    throw new Error('AgentCore Browser StartBrowserSession returned no sessionId or automation endpoint');
  }

  logger.info('AgentCore Browser session started', {
    session_id: sessionId,
    automation_endpoint: automationEndpoint,
  });

  try {
    const png = await runCdpScreenshot(automationEndpoint, url, timeoutMs);
    return png;
  } finally {
    try {
      await client.send(new StopBrowserSessionCommand({
        browserIdentifier: AWS_BROWSER_IDENTIFIER,
        sessionId,
      }));
    } catch (err) {
      logger.warn('Failed to stop AgentCore Browser session (will auto-expire)', {
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function runCdpScreenshot(wssUrl: string, url: string, timeoutMs: number): Promise<Uint8Array> {
  const signedUrl = await sigV4PresignWss(wssUrl);
  const ws = new WebSocket(signedUrl);

  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  let nextCdpId = 1;

  const pending = new Map<number, { resolve: (msg: CdpMessage) => void; reject: (err: Error) => void }>();
  const eventQueue: CdpMessage[] = [];
  interface EventWaiter {
    readonly predicate: (msg: CdpMessage) => boolean;
    readonly resolve: (msg: CdpMessage) => void;
  }
  const eventWaiters: EventWaiter[] = [];

  // CDP can deliver the main document's `Network.responseReceived` before the `Page.navigate` response that carries its frameId.
  const documentStatusByFrame = new Map<string, number>();

  ws.on('message', (raw: RawData) => {
    const data = raw.toString();
    let msg: CdpMessage;
    try {
      msg = JSON.parse(data) as CdpMessage;
    } catch {
      return;
    }
    if (msg.method === 'Network.responseReceived') {
      const params = msg.params as
        | { type?: string; frameId?: string; response?: { status?: number } }
        | undefined;
      if (params?.type === 'Document' && typeof params.frameId === 'string') {
        const status = params.response?.status;
        if (typeof status === 'number') documentStatusByFrame.set(params.frameId, status);
      }
      return;
    }
    if (typeof msg.id === 'number') {
      const slot = pending.get(msg.id);
      if (slot) {
        pending.delete(msg.id);
        if (msg.error) {
          slot.reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          slot.resolve(msg);
        }
      }
    } else if (msg.method) {
      const waiterIdx = eventWaiters.findIndex((w) => w.predicate(msg));
      if (waiterIdx !== -1) {
        const [waiter] = eventWaiters.splice(waiterIdx, 1);
        waiter.resolve(msg);
      } else {
        eventQueue.push(msg);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (err: Error): void => {
      cleanup();
      try { ws.terminate(); } catch { /* socket may already be closed */ }
      reject(new Error(`AgentCore Browser WebSocket error: ${err.message || '(no message)'}`));
    };
    const onUnexpectedResponse = (_req: unknown, res: { statusCode?: number }): void => {
      cleanup();
      try { ws.terminate(); } catch { /* socket may already be closed */ }
      reject(new Error(`AgentCore Browser WebSocket handshake failed: HTTP ${res.statusCode ?? '?'}`));
    };
    const cleanup = (): void => {
      ws.removeListener('open', onOpen);
      ws.removeListener('error', onError);
      ws.removeListener('unexpected-response', onUnexpectedResponse);
    };
    ws.on('open', onOpen);
    ws.on('error', onError);
    ws.on('unexpected-response', onUnexpectedResponse);
    setTimeout(() => {
      cleanup();
      try { ws.terminate(); } catch { /* socket may already be closed */ }
      reject(new Error(`AgentCore Browser WebSocket open timeout after ${timeoutMs}ms`));
    }, remaining());
  });

  function cdpSend(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpMessage> {
    const id = nextCdpId++;
    const message: CdpMessage = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    const budgetMs = remaining();
    return new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${budgetMs}ms`));
      }, budgetMs);
      pending.set(id, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      ws.send(JSON.stringify(message));
    });
  }

  function waitForEvent(method: string): Promise<CdpMessage> {
    const queued = eventQueue.findIndex((m) => m.method === method);
    if (queued !== -1) {
      const [match] = eventQueue.splice(queued, 1);
      return Promise.resolve(match);
    }
    return new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = eventWaiters.findIndex((w) => w.resolve === wrappedResolve);
        if (idx !== -1) eventWaiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, remaining());
      const wrappedResolve = (msg: CdpMessage): void => {
        clearTimeout(timer);
        resolve(msg);
      };
      eventWaiters.push({
        predicate: (msg) => msg.method === method,
        resolve: wrappedResolve,
      });
    });
  }

  try {
    const targetsResp = await cdpSend('Target.getTargets');
    const targetInfos = narrowTargetInfos(targetsResp.result);
    const pageTarget = targetInfos.find((t) => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target found in AgentCore Browser session');
    }

    const attachResp = await cdpSend('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    const pageSessionId = narrowSessionId(attachResp.result);
    if (!pageSessionId) {
      throw new Error('Target.attachToTarget did not return a sessionId');
    }

    await cdpSend('Page.enable', {}, pageSessionId);
    await cdpSend('Network.enable', {}, pageSessionId);

    const navResp = await cdpSend('Page.navigate', { url }, pageSessionId);
    const navError = narrowNavigateError(navResp.result);
    if (navError) {
      throw new Error(`Page.navigate failed: ${navError}`);
    }
    const mainDocumentFrameId = (navResp.result?.frameId as string | undefined) ?? null;

    await waitForEvent('Page.loadEventFired');
    await new Promise((r) => setTimeout(r, PAGE_SETTLE_WAIT_MS));

    let mainDocumentStatus: number | null = null;
    if (mainDocumentFrameId !== null) {
      mainDocumentStatus = documentStatusByFrame.get(mainDocumentFrameId) ?? null;
    } else if (documentStatusByFrame.size === 1) {
      mainDocumentStatus = documentStatusByFrame.values().next().value ?? null;
    }
    if (mainDocumentStatus !== null && (mainDocumentStatus < HTTP_STATUS_SUCCESS_MIN || mainDocumentStatus >= HTTP_STATUS_REDIRECT_MIN)) {
      throw new Error(`Preview URL returned HTTP ${mainDocumentStatus}; skipping screenshot`);
    }

    const shotResp = await cdpSend('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    }, pageSessionId);
    const base64 = narrowScreenshotData(shotResp.result);
    if (!base64) {
      throw new Error('Page.captureScreenshot returned no data');
    }
    return Buffer.from(base64, 'base64');
  } finally {
    try { ws.close(); } catch { /* ignore */ }
  }
}

async function sigV4PresignWss(wssUrl: string): Promise<string> {
  const u = new URL(wssUrl);
  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
    applyChecksum: false,
  });

  // SigV4 signs the method, host, path and query, not the scheme: the signed query is valid on the wss:// URL.
  const queryEntries = Array.from(u.searchParams.entries());
  const query: Record<string, string> = {};
  for (const [k, v] of queryEntries) query[k] = v;

  const req = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: u.hostname,
    path: u.pathname,
    query,
    headers: { host: u.hostname },
  });

  const presigned = await signer.presign(req, { expiresIn: 60 });
  const out = new URL(wssUrl);
  for (const [k, v] of Object.entries(presigned.query ?? {})) {
    out.searchParams.set(k, Array.isArray(v) ? v[0] : (v as string));
  }
  return out.toString();
}

interface TargetInfo {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
}

function narrowTargetInfos(result: Record<string, unknown> | undefined): TargetInfo[] {
  const infos = result?.targetInfos;
  if (!Array.isArray(infos)) return [];
  return infos.filter((t): t is TargetInfo =>
    typeof t === 'object' && t !== null
    && typeof (t as Record<string, unknown>).targetId === 'string'
    && typeof (t as Record<string, unknown>).type === 'string'
    && typeof (t as Record<string, unknown>).url === 'string',
  );
}

function narrowSessionId(result: Record<string, unknown> | undefined): string | undefined {
  const id = result?.sessionId;
  return typeof id === 'string' ? id : undefined;
}

function narrowNavigateError(result: Record<string, unknown> | undefined): string | undefined {
  const err = result?.errorText;
  return typeof err === 'string' ? err : undefined;
}

function narrowScreenshotData(result: Record<string, unknown> | undefined): string | undefined {
  const data = result?.data;
  return typeof data === 'string' ? data : undefined;
}
