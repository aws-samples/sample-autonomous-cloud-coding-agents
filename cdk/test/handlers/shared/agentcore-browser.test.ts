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

function emitLoadEventFired(): void {
  setImmediate(() => {
    FakeWebSocket.last!.emit('message', JSON.stringify({ method: 'Page.loadEventFired' }));
  });
}

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
    bedrockSend.mockResolvedValueOnce({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('200 main-document status → captures screenshot as before', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [networkResponseEvent(200, 'frame-1')],
      }),
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
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [
          {
            method: 'Network.responseReceived',
            params: { type: 'Stylesheet', frameId: 'frame-1', response: { status: 404 } },
          },
          networkResponseEvent(200, 'frame-1'),
        ],
      }),
      () => ({ result: { data: Buffer.from('PNG').toString('base64') } }),
    ];
    emitLoadEventFired();

    await expect(captureScreenshot('https://preview.example.com')).resolves.toBeDefined();
  });

  test('sub-frame 404 after main-frame 200 → still captures (per-frame attribution)', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [
          networkResponseEvent(200, 'frame-1'),
          networkResponseEvent(404, 'iframe-ads'),
        ],
      }),
      () => ({ result: { data: Buffer.from('PNG-main-ok').toString('base64') } }),
    ];
    emitLoadEventFired();

    const png = await captureScreenshot('https://preview.example.com');
    expect(Buffer.from(png).toString()).toBe('PNG-main-ok');
  });

  test('sub-frame 200 after main-frame 404 → still throws (per-frame attribution)', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [
          networkResponseEvent(404, 'frame-1'),
          networkResponseEvent(200, 'iframe-embed'),
        ],
      }),
      () => {
        throw new Error('captureScreenshot should not run on non-2xx');
      },
    ];
    emitLoadEventFired();

    await expect(captureScreenshot('https://preview.example.com/missing')).rejects.toThrow(
      /Preview URL returned HTTP 404/,
    );
  });

  test('redirect chain on the main frame → final status wins', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: { frameId: 'frame-1' } },
        _events: [
          networkResponseEvent(302, 'frame-1'),
          networkResponseEvent(200, 'frame-1'),
        ],
      }),
      () => ({ result: { data: Buffer.from('PNG-redirected').toString('base64') } }),
    ];
    emitLoadEventFired();

    const png = await captureScreenshot('https://preview.example.com/old');
    expect(Buffer.from(png).toString()).toBe('PNG-redirected');
  });

  test('navigate returns no frameId + single Document status → status still used', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: {} },
        _events: [networkResponseEvent(503, 'frame-unknown')],
      }),
    ];
    emitLoadEventFired();

    await expect(captureScreenshot('https://preview.example.com/down')).rejects.toThrow(/HTTP 503/);
  });

  test('navigate returns no frameId + multiple ambiguous Document statuses → captures optimistically', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({
        _response: { result: {} },
        _events: [
          networkResponseEvent(404, 'frame-a'),
          networkResponseEvent(200, 'frame-b'),
        ],
      }),
      () => ({ result: { data: Buffer.from('PNG-ambiguous').toString('base64') } }),
    ];
    emitLoadEventFired();

    const png = await captureScreenshot('https://preview.example.com');
    expect(Buffer.from(png).toString()).toBe('PNG-ambiguous');
  });

  test('no Network.responseReceived event ever fires → falls through (pre-#287 behaviour)', async () => {
    FakeWebSocket.reactions = [
      () => ({ result: { targetInfos: [{ targetId: 't1', type: 'page', url: 'about:blank' }] } }),
      () => ({ result: { sessionId: 'flat-sess' } }),
      () => ({ result: {} }),
      () => ({ result: {} }),
      () => ({ result: { frameId: 'frame-1' } }),
      () => ({ result: { data: Buffer.from('PNG').toString('base64') } }),
    ];
    emitLoadEventFired();

    const png = await captureScreenshot('https://preview.example.com');
    expect(Buffer.from(png).toString()).toBe('PNG');
  });

  test('a command that gets no answer reports the time it was given, not what is left when the timer fires', async () => {
    FakeWebSocket.reactions = [() => null];

    const error = await captureScreenshot('https://preview.example.com', { timeoutMs: 200 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const given = /^CDP Target\.getTargets timed out after (\d+)ms$/.exec((error as Error).message);
    expect(given).not.toBeNull();
    expect(Number(given![1])).toBeGreaterThan(0);
    expect(Number(given![1])).toBeLessThanOrEqual(200);
  });
});
