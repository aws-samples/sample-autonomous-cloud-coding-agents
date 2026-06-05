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
  public sentMessages: string[] = [];
  public closed = false;
  // Latest instance — tests reach in to drive message events.
  public static last: FakeWebSocket | null = null;
  /** Override per-test to inject failures on construction. */
  public static onConstruct: ((url: string, ws: FakeWebSocket) => void) | null = null;

  constructor(public url: string) {
    super();
    FakeWebSocket.last = this;
    // Fire `open` on the next tick so callers can wire listeners first.
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
    // Auto-respond from the per-test scripted reactions.
    const msg = JSON.parse(data) as { id: number; method: string; sessionId?: string };
    const reaction = FakeWebSocket.reactions.shift();
    if (reaction) {
      const reply = reaction(msg);
      if (reply !== null) {
        // Echo the id back so the caller's pending map resolves.
        setImmediate(() => this.emit('message', JSON.stringify({ ...reply, id: msg.id })));
      }
    }
  }

  close(): void {
    this.closed = true;
  }

  /** Per-test scripted reactions — one per cdpSend call, in order. */
  public static reactions: Array<(msg: { id: number; method: string }) => Record<string, unknown> | null> = [];
}

jest.mock('ws', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((url: string) => new FakeWebSocket(url)),
}));

import { captureScreenshot } from '../../../src/handlers/shared/agentcore-browser';

describe('captureScreenshot', () => {
  beforeEach(() => {
    bedrockSend.mockReset();
    FakeWebSocket.last = null;
    FakeWebSocket.reactions = [];
    FakeWebSocket.onConstruct = null;
  });

  test('throws if StartBrowserSession returns no sessionId / endpoint', async () => {
    bedrockSend.mockResolvedValueOnce({ sessionId: undefined, streams: undefined });
    await expect(captureScreenshot('https://x')).rejects.toThrow(/no sessionId/);
  });

  test('happy path: drives CDP, returns PNG bytes, stops the session', async () => {
    // Start
    bedrockSend.mockResolvedValueOnce({
      sessionId: 'sess-1',
      streams: {
        automationStream: { streamEndpoint: 'wss://example.com/automation' },
      },
    });
    // Stop (in finally)
    bedrockSend.mockResolvedValueOnce({});

    // CDP exchange — one reaction per send() in order:
    //  1. Target.getTargets         → return one page target
    //  2. Target.attachToTarget     → return sessionId
    //  3. Page.enable               → ack {}
    //  4. Page.navigate             → ack {}
    //  5. Page.captureScreenshot    → return base64 PNG
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => {
        // Navigation succeeded; emit Page.loadEventFired event next tick.
        setImmediate(() => {
          FakeWebSocket.last!.emit('message', JSON.stringify({ method: 'Page.loadEventFired' }));
        });
        return { result: {} };
      },
      () => ({ result: { data: Buffer.from('PNG-DATA').toString('base64') } }),
    ];

    // Skip the 2-second post-load settle — keep test fast.
    const realSetTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
      // Fire 2-second settle synchronously, but preserve real timer
      // behaviour for the deadline-tracking timeouts (long delays).
      if (typeof ms === 'number' && ms === 2000) {
        cb();
        return 0 as unknown as NodeJS.Timeout;
      }
      return realSetTimeout(cb, ms);
    }) as typeof global.setTimeout);

    const png = await captureScreenshot('https://preview.example.com');

    expect(Buffer.from(png).toString()).toBe('PNG-DATA');
    // StartBrowserSession + StopBrowserSession both called.
    expect(bedrockSend).toHaveBeenCalledTimes(2);
    // WSS URL was presigned with SigV4 query params — must contain the
    // canonical X-Amz- headers.
    expect(FakeWebSocket.last!.url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(FakeWebSocket.last!.url).toContain('X-Amz-Credential=');
    expect(FakeWebSocket.last!.url).toContain('X-Amz-Signature=');
    // Socket closed on the way out.
    expect(FakeWebSocket.last!.closed).toBe(true);
  });

  test('still attempts StopBrowserSession on CDP failure (best-effort cleanup)', async () => {
    bedrockSend.mockResolvedValueOnce({
      sessionId: 'sess-1',
      streams: { automationStream: { streamEndpoint: 'wss://example.com/automation' } },
    });
    bedrockSend.mockResolvedValueOnce({});

    // Target.getTargets returns NO page target → should throw.
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [] } }),
    ];

    await expect(captureScreenshot('https://x')).rejects.toThrow(/No page target/);
    // Stop was still called.
    const stopCalls = bedrockSend.mock.calls.filter((c) => (c[0] as { _type: string })._type === 'Stop');
    expect(stopCalls.length).toBe(1);
  });

  test('logs but does not throw when StopBrowserSession itself fails', async () => {
    bedrockSend
      .mockResolvedValueOnce({
        sessionId: 'sess-1',
        streams: { automationStream: { streamEndpoint: 'wss://example.com/automation' } },
      })
      .mockRejectedValueOnce(new Error('stop failed')); // Stop in finally

    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [] } }), // -> caller throws "No page target"
    ];

    // Original error from try-block surfaces; finally's Stop error is logged.
    await expect(captureScreenshot('https://x')).rejects.toThrow(/No page target/);
  });

  test('rejects when WS upgrade returns unexpected-response (e.g. 403)', async () => {
    bedrockSend.mockResolvedValueOnce({
      sessionId: 'sess-1',
      streams: { automationStream: { streamEndpoint: 'wss://example.com/automation' } },
    });
    bedrockSend.mockResolvedValueOnce({});

    FakeWebSocket.onConstruct = (_url, ws) => {
      setImmediate(() => ws.emit('unexpected-response', {}, { statusCode: 403 }));
    };

    await expect(captureScreenshot('https://x')).rejects.toThrow(/handshake failed: HTTP 403/);
  });

  test('Page.navigate that errors throws with the error text', async () => {
    bedrockSend.mockResolvedValueOnce({
      sessionId: 'sess-1',
      streams: { automationStream: { streamEndpoint: 'wss://example.com/automation' } },
    });
    bedrockSend.mockResolvedValueOnce({});

    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: { errorText: 'net::ERR_CONNECTION_REFUSED' } }),
    ];

    await expect(captureScreenshot('https://broken')).rejects.toThrow(/net::ERR_CONNECTION_REFUSED/);
  });
});
