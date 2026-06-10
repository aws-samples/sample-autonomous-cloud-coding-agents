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

import { EventEmitter } from 'events';

const bedrockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn(() => ({ send: bedrockSend })),
  StartBrowserSessionCommand: jest.fn((input: unknown) => ({ _type: 'Start', input })),
  StopBrowserSessionCommand: jest.fn((input: unknown) => ({ _type: 'Stop', input })),
}));

// Static credentials so SigV4 doesn't reach for real AWS metadata.
jest.mock('@aws-sdk/credential-provider-node', () => ({
  defaultProvider: () => async () => ({
    accessKeyId: 'AKIATEST',
    secretAccessKey: 'secret',
    sessionToken: 'token',
  }),
}));

class FakeWebSocket extends EventEmitter {
  public static last: FakeWebSocket | null = null;
  public static onConstruct: ((url: string, ws: FakeWebSocket) => void) | null = null;
  /**
   * Per-test scripted reactions. Each function returns either:
   *  - an object: a CDP response keyed back to the request id
   *  - an object with `events` array: response + extra unsolicited events (e.g. Network.responseReceived) emitted before the response
   *  - null: no response (caller times out)
   */
  public static reactions: Array<
    (msg: { id: number; method: string; sessionId?: string }) =>
      | Record<string, unknown>
      | { _response: Record<string, unknown>; _events?: Array<Record<string, unknown>> }
      | null
  > = [];

  public sentMessages: string[] = [];
  public closed = false;

  constructor(public url: string) {
    super();
    FakeWebSocket.last = this;
    setImmediate(() => {
      if (FakeWebSocket.onConstruct) {
        FakeWebSocket.onConstruct(url, this);
      } else {
        this.emit('open');
      }
    });
  }

  send(data: string): void {
    this.sentMessages.push(data);
    const msg = JSON.parse(data) as { id: number; method: string; sessionId?: string };
    const reaction = FakeWebSocket.reactions.shift();
    if (!reaction) return;
    const result = reaction(msg);
    if (result === null) return;
    // Detect the `{_response, _events}` wrapper for tests that need to
    // emit unsolicited events alongside the request's response.
    if ('_response' in result) {
      const wrapped = result as {
        _response: Record<string, unknown>;
        _events?: Array<Record<string, unknown>>;
      };
      if (wrapped._events) {
        for (const ev of wrapped._events) {
          setImmediate(() => this.emit('message', JSON.stringify(ev)));
        }
      }
      setImmediate(() => this.emit('message', JSON.stringify({ ...wrapped._response, id: msg.id })));
    } else {
      setImmediate(() => this.emit('message', JSON.stringify({ ...result, id: msg.id })));
    }
  }

  close(): void {
    this.closed = true;
  }

  terminate(): void {
    this.closed = true;
  }
}

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((url: string) => new FakeWebSocket(url)),
}));

import { captureScreenshot } from '../../../src/handlers/shared/agentcore-browser';

/** Helper: emit Page.loadEventFired on the next tick. */
function emitLoadEventFired(): void {
  setImmediate(() => {
    FakeWebSocket.last!.emit('message', JSON.stringify({ method: 'Page.loadEventFired' }));
  });
}

/** Build a Network.responseReceived event for the main document with the given status. */
function networkResponseEvent(status: number, frameId = 'frame-1'): Record<string, unknown> {
  return {
    method: 'Network.responseReceived',
    params: {
      type: 'Document',
      frameId,
      response: { status },
    },
  };
}

describe('captureScreenshot — main-document status check (issue #287)', () => {
  beforeEach(() => {
    bedrockSend.mockReset();
    FakeWebSocket.last = null;
    FakeWebSocket.reactions = [];
    FakeWebSocket.onConstruct = null;
    // Skip the 2-second post-load settle.
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms === 2000) {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(cb, ms);
    }) as typeof global.setTimeout);

    bedrockSend.mockResolvedValueOnce({
      sessionId: 'sess-1',
      streams: { automationStream: { streamEndpoint: 'wss://example.com/automation' } },
    });
    bedrockSend.mockResolvedValueOnce({}); // Stop in finally
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('200 main-document status → captures screenshot as before', async () => {
    FakeWebSocket.reactions = [
      // Target.getTargets
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      // Target.attachToTarget
      () => ({ result: { sessionId: 'flat-sess' } }),
      // Page.enable
      () => ({ result: {} }),
      // Network.enable
      () => ({ result: {} }),
      // Page.navigate — also emit Network.responseReceived (200) + load event
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [networkResponseEvent(200, 'frame-1')],
      }),
      // Page.captureScreenshot
      () => ({ result: { data: Buffer.from('PNG-200').toString('base64') } }),
    ];
    emitLoadEventFired();

    const png = await captureScreenshot('https://preview.example.com');
    expect(Buffer.from(png).toString()).toBe('PNG-200');
  });

  test('404 main-document status → throws "Preview URL returned HTTP 404"', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [networkResponseEvent(404, 'frame-1')],
      }),
      // Page.captureScreenshot should NEVER be called — fail loud if it is
      () => {
        throw new Error('captureScreenshot should not run on non-2xx');
      },
    ];
    emitLoadEventFired();

    await expect(captureScreenshot('https://preview.example.com/missing')).rejects.toThrow(
      /Preview URL returned HTTP 404/,
    );
  });

  test('503 main-document status → throws', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [networkResponseEvent(503, 'frame-1')],
      }),
    ];
    emitLoadEventFired();

    await expect(captureScreenshot('https://preview.example.com/down')).rejects.toThrow(/HTTP 503/);
  });

  test('301 redirect → main document status is the redirect; throw', async () => {
    // 3xx responses are still non-2xx so we treat them as failure; CDP's
    // typical behaviour with redirects is that the FINAL response gets
    // a 200 type=Document, but if a 3xx surfaces we should not silently
    // capture an unexpected page. (Real-world: Vercel auth-wall returns
    // 200 directly so this is mostly defensive — but assert the policy.)
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [networkResponseEvent(301, 'frame-1')],
      }),
    ];
    emitLoadEventFired();

    await expect(captureScreenshot('https://preview.example.com/old')).rejects.toThrow(/HTTP 301/);
  });

  test('Network.responseReceived for non-Document resource is ignored', async () => {
    // Only Document-type responses set the captured status. JS/CSS/XHR
    // responses on the same frame must not trigger the non-2xx branch.
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [
          // A 404 on a stylesheet request — not the main document.
          {
            method: 'Network.responseReceived',
            params: { type: 'Stylesheet', frameId: 'frame-1', response: { status: 404 } },
          },
          // The actual main-document response is 200.
          networkResponseEvent(200, 'frame-1'),
        ],
      }),
      () => ({ result: { data: Buffer.from('PNG').toString('base64') } }),
    ];
    emitLoadEventFired();

    await expect(captureScreenshot('https://preview.example.com')).resolves.toBeDefined();
  });

  test('no Network.responseReceived event ever fires → falls through (pre-#287 behaviour)', async () => {
    // Defensive: if some service variant doesn't emit Network events,
    // we still capture optimistically rather than blocking the pipeline.
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      // Page.navigate — no events emitted alongside; only the response.
      () => ({ result: { frameId: 'frame-1' } }),
      () => ({ result: { data: Buffer.from('PNG').toString('base64') } }),
    ];
    emitLoadEventFired();

    const png = await captureScreenshot('https://preview.example.com');
    expect(Buffer.from(png).toString()).toBe('PNG');
  });
});
