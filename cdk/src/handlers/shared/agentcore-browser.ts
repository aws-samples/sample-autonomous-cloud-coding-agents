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

const REGION = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';

/**
 * AWS-managed default browser identifier. AgentCore Browser publishes a
 * shared browser at this id without provisioning. (We could call
 * `CreateBrowser` to get a dedicated one, but the screenshot path
 * doesn't need any custom config — keep it simple.)
 */
const AWS_BROWSER_IDENTIFIER = 'aws.browser.v1';

/**
 * Default budget for the entire screenshot job (start session → navigate
 * → screenshot → stop). Lambda timeout should be at least 15s above this
 * to leave headroom for the JSON encode + S3 PUT after the screenshot.
 */
const DEFAULT_TIMEOUT_MS = 60_000;

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
 * Implementation notes:
 *  - Uses the native `WebSocket` (Node 24+) and speaks Chrome DevTools
 *    Protocol directly. Avoids pulling in Playwright / puppeteer-core
 *    into the Lambda bundle (would be ~150 MB).
 *  - The automation WSS endpoint requires a SigV4-signed handshake
 *    request. Browser session creation is a normal SigV4 SDK call;
 *    once the session is created, the WSS upgrade GET also needs
 *    SigV4 headers in `Sec-WebSocket-*` companion form. Node's
 *    `WebSocket` constructor accepts a custom `Headers` object via
 *    the `protocols`/`headers` slot in `clientOptions`.
 *  - The flow is intentionally minimal:
 *      1. StartBrowserSession (REST API; SDK call)
 *      2. WS connect to the automation streamEndpoint (SigV4 handshake)
 *      3. CDP `Target.attachToBrowserTarget` to get a flat session
 *      4. CDP `Target.getTargets`, find the about:blank page
 *      5. `Target.attachToTarget` (flatten=true) on that page → sessionId
 *      6. `Page.navigate` + wait for `Page.loadEventFired`
 *      7. `Page.captureScreenshot` (returns base64 PNG)
 *      8. StopBrowserSession (best-effort; sessions auto-expire)
 *
 *  We don't try to be clever about fonts, viewports, or cookie
 *  injection — the agent is just snapshotting public preview URLs
 *  that render with default settings (no auth, no per-user state).
 *
 * @param url The URL to navigate to and screenshot.
 * @param opts.timeoutMs Override the default 60s budget.
 * @returns Raw PNG bytes (NOT base64-wrapped) ready for S3.PutObject.
 */
export async function captureScreenshot(url: string, opts: { timeoutMs?: number } = {}): Promise<Uint8Array> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const client = new BedrockAgentCoreClient({ region: REGION });

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
      // Sessions auto-expire after ~10 minutes if we leak — log and move on.
      logger.warn('Failed to stop AgentCore Browser session (will auto-expire)', {
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Open the automation WebSocket, drive CDP, return PNG bytes. Caller is
 * responsible for the StartBrowserSession + StopBrowserSession lifecycle.
 */
async function runCdpScreenshot(wssUrl: string, url: string, timeoutMs: number): Promise<Uint8Array> {
  // AgentCore Browser's WSS endpoint accepts SigV4 in two forms: signed
  // `Authorization` headers OR signed query parameters (presigned URL).
  // We use the presigned-URL form because the `Host` header sent by the
  // WS upgrade (handled inside `ws`) doesn't always match what we signed
  // when using header-based auth, leading to 403s. Query-param signing
  // sidesteps the Host-header reconciliation entirely.
  const signedUrl = await sigV4PresignWss(wssUrl);
  const ws = new WebSocket(signedUrl);

  const deadline = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  // CDP message id allocator. Scoped to the function so concurrent
  // captures (unusual but possible in tests) don't share counter state.
  let nextCdpId = 1;

  // Promise machinery for tracking in-flight CDP requests by `id`.
  const pending = new Map<number, { resolve: (msg: CdpMessage) => void; reject: (err: Error) => void }>();
  const eventQueue: CdpMessage[] = [];
  // Each waiter has a predicate; on each incoming event we deliver to the
  // FIRST waiter whose predicate matches, otherwise queue the event.
  interface EventWaiter {
    readonly predicate: (msg: CdpMessage) => boolean;
    readonly resolve: (msg: CdpMessage) => void;
  }
  const eventWaiters: EventWaiter[] = [];

  // Track the latest Document response status PER FRAME so we can fail fast
  // on 4xx/5xx (404 / 503 / auth wall pages) instead of capturing what looks
  // like the app but isn't. The main frame's id is only known once
  // Page.navigate resolves, but `Network.responseReceived` for the main
  // document frequently arrives BEFORE that response — so record every
  // Document status keyed by frameId and resolve which one is the main
  // document afterwards. (Recording a single "latest" status instead would
  // race: an early sub-frame response could be misattributed as the main
  // document, or the real main-document status missed entirely.)
  // Redirect chains re-fire for the same frameId; last write wins, which is
  // the final response. (Auth walls that return 200 are out of scope — #287.)
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
      // CDP's `Network.responseReceived` fires for every resource (HTML,
      // JS, CSS, images, XHR, …). Only type==='Document' responses are
      // candidate main-document responses.
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

  // Open the socket. `ws` exposes node-style EventEmitter; the
  // `unexpected-response` event surfaces HTTP-level handshake failures
  // (e.g. 403 from misaligned SigV4) so we can log a meaningful error
  // instead of an empty `error` event.
  //
  // Failure paths must close the socket — without `terminate()` on the
  // open-timeout path, a hung handshake leaks the underlying TCP
  // connection per failed attempt (review nit, PR #241).
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
    return new Promise<CdpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${remaining()}ms`));
      }, remaining());
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
    // 1. List existing targets, find the default about:blank page.
    const targetsResp = await cdpSend('Target.getTargets');
    const targetInfos = narrowTargetInfos(targetsResp.result);
    const pageTarget = targetInfos.find((t) => t.type === 'page');
    if (!pageTarget) {
      throw new Error('No page target found in AgentCore Browser session');
    }

    // 2. Attach with flatten=true to get a sessionId we can route subsequent commands to.
    const attachResp = await cdpSend('Target.attachToTarget', {
      targetId: pageTarget.targetId,
      flatten: true,
    });
    const pageSessionId = narrowSessionId(attachResp.result);
    if (!pageSessionId) {
      throw new Error('Target.attachToTarget did not return a sessionId');
    }

    // 3. Enable Page + Network so we get the `Page.loadEventFired` event
    //    we wait on below AND the main-document response status. Network
    //    has to be enabled BEFORE Page.navigate, or the response event
    //    fires before our listener is wired and we miss the status.
    //    (Document statuses are recorded per-frame by the single message
    //    listener above; we resolve the main frame's status after load.)
    await cdpSend('Page.enable', {}, pageSessionId);
    await cdpSend('Network.enable', {}, pageSessionId);

    // 4. Navigate. The response includes a `frameId`; we wait on the
    //    `Page.loadEventFired` event below (more reliable than
    //    `frameStoppedLoading` which can fire before navigation
    //    actually starts on `about:blank` → real-URL transitions).
    const navResp = await cdpSend('Page.navigate', { url }, pageSessionId);
    const navError = narrowNavigateError(navResp.result);
    if (navError) {
      throw new Error(`Page.navigate failed: ${navError}`);
    }
    const mainDocumentFrameId = (navResp.result?.frameId as string | undefined) ?? null;

    // 5. Wait for the page load event. SPA-style apps may continue
    //    fetching after this fires, so add a 2s settle wait. For
    //    typical preview URLs (Vercel/Netlify/Amplify CDN edges) this
    //    is enough.
    await waitForEvent('Page.loadEventFired');
    await new Promise((r) => setTimeout(r, 2000));

    // 6. Reject non-2xx main-document statuses before screenshotting.
    //    A 404 / 503 / auth wall renders a "successful" page from CDP's
    //    perspective; the user sees a confidently-wrong screenshot of an
    //    error page posted as the deploy preview. Throw → processor's
    //    catch logs and skips the PR/Linear comment cleanly.
    //    The main frame's id comes from the Page.navigate response; its
    //    Document responses were recorded per-frame by the message
    //    listener even if they arrived before navigate resolved. If
    //    Page.navigate returned no frameId, only an unambiguous single
    //    recorded status is trusted — with multiple frames we cannot
    //    tell which is the main document.
    //    If we never captured a status (e.g. a service variant that
    //    doesn't emit Network events), fall through and capture
    //    optimistically; that's the pre-#287 behaviour.
    let mainDocumentStatus: number | null = null;
    if (mainDocumentFrameId !== null) {
      mainDocumentStatus = documentStatusByFrame.get(mainDocumentFrameId) ?? null;
    } else if (documentStatusByFrame.size === 1) {
      mainDocumentStatus = documentStatusByFrame.values().next().value ?? null;
    }
    if (mainDocumentStatus !== null && (mainDocumentStatus < 200 || mainDocumentStatus >= 300)) {
      throw new Error(`Preview URL returned HTTP ${mainDocumentStatus}; skipping screenshot`);
    }

    // 7. Take the screenshot.
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

/**
 * Presign the WSS URL with SigV4 query parameters. AgentCore Browser
 * accepts auth either as headers on the upgrade GET or as query params
 * on the URL itself; the latter is more robust through WebSocket
 * clients that rewrite Host headers (e.g. `ws`).
 *
 * Returns a `wss://...?X-Amz-Algorithm=...&X-Amz-Credential=...&...`
 * URL ready to pass straight to `new WebSocket(...)`.
 */
async function sigV4PresignWss(wssUrl: string): Promise<string> {
  const u = new URL(wssUrl);
  const signer = new SignatureV4({
    service: 'bedrock-agentcore',
    region: REGION,
    credentials: defaultProvider(),
    sha256: Sha256,
    applyChecksum: false,
  });

  // Convert wss:// → https:// for the signing request (SigV4 doesn't
  // know about wss). The signature is over the path + query, so the
  // protocol on the signed request is irrelevant — we paste the auth
  // params back onto the original wss:// URL.
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

  // 60s expiry is fine — we open the socket immediately after signing.
  const presigned = await signer.presign(req, { expiresIn: 60 });
  const out = new URL(wssUrl);
  for (const [k, v] of Object.entries(presigned.query ?? {})) {
    out.searchParams.set(k, Array.isArray(v) ? v[0] : (v as string));
  }
  return out.toString();
}

/**
 * Type-narrow helpers for CDP response shapes. Replaces inline `as`
 * casts with checked accessors so a malformed response is logged as
 * `null`/`undefined` rather than silently miscoerced. (theagenticguy
 * PR-241 review: reduce unchecked casts in CDP plumbing.)
 */
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
