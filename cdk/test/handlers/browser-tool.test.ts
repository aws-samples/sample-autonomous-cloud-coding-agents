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

// --- Mocks ---
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agentcore', () => ({
  BedrockAgentCoreClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  StartBrowserSessionCommand: jest.fn().mockImplementation((input) => ({ input })),
  StopBrowserSessionCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  PutObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
  GetObjectCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/presigned'),
}));

jest.mock('ws', () => {
  return jest.fn().mockImplementation(() => {
    const handlers: Record<string, Function[]> = {};
    const ws = {
      on: jest.fn((event: string, cb: Function) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event].push(cb);
        // Auto-fire 'open' event on registration
        if (event === 'open') {
          setTimeout(() => cb(), 0);
        }
      }),
      off: jest.fn((event: string, cb: Function) => {
        if (handlers[event]) {
          handlers[event] = handlers[event].filter(h => h !== cb);
        }
      }),
      send: jest.fn((data: string) => {
        const msg = JSON.parse(data);
        setTimeout(() => {
          if (msg.method === 'Page.enable') {
            handlers['message']?.forEach(h => h(JSON.stringify({ id: msg.id, result: {} })));
          } else if (msg.method === 'Page.navigate') {
            handlers['message']?.forEach(h => h(JSON.stringify({ id: msg.id, result: { frameId: '1' } })));
            handlers['message']?.forEach(h => h(JSON.stringify({ method: 'Page.loadEventFired' })));
          } else if (msg.method === 'Page.captureScreenshot') {
            handlers['message']?.forEach(h => h(JSON.stringify({ id: msg.id, result: { data: 'base64png' } })));
          }
        }, 0);
      }),
      close: jest.fn(),
      readyState: 1,
    };
    return ws;
  });
});

import { handler } from '../../src/handlers/browser-tool';

describe('browser-tool handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.BROWSER_ID = 'test-browser-id';
    process.env.SCREENSHOT_BUCKET_NAME = 'test-screenshot-bucket';
    process.env.AWS_REGION = 'us-east-1';
  });

  afterEach(() => {
    delete process.env.BROWSER_ID;
    delete process.env.SCREENSHOT_BUCKET_NAME;
    delete process.env.AWS_REGION;
  });

  test('returns screenshot on success', async () => {
    mockSend
      .mockResolvedValueOnce({
        sessionId: 'session-123',
        streams: {
          automationStream: {
            streamEndpoint: 'wss://example.com/stream',
            streamStatus: 'ENABLED',
          },
        },
      })
      .mockResolvedValueOnce({});

    const result = await handler({
      action: 'screenshot',
      url: 'https://example.com',
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: 'success',
        presignedUrl: 'https://s3.example.com/presigned',
      }),
    );

    // Verify StopBrowserSession was called
    const { StopBrowserSessionCommand } = require('@aws-sdk/client-bedrock-agentcore');
    expect(StopBrowserSessionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-123' }),
    );
  });

  test('returns error on session failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('Session start failed'));

    const result = await handler({
      action: 'screenshot',
      url: 'https://example.com',
    });

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('Session start failed'),
      }),
    );
  });

  test('stops session in finally block even on error', async () => {
    mockSend
      .mockResolvedValueOnce({
        sessionId: 'session-456',
        streams: {
          automationStream: {
            streamEndpoint: 'wss://example.com/stream',
            streamStatus: 'ENABLED',
          },
        },
      })
      .mockResolvedValueOnce({});

    // Override S3 upload to fail
    mockS3Send.mockRejectedValueOnce(new Error('S3 upload failed'));

    const result = await handler({
      action: 'screenshot',
      url: 'https://example.com',
    });

    // Session should still be stopped even though S3 failed
    const { StopBrowserSessionCommand } = require('@aws-sdk/client-bedrock-agentcore');
    expect(StopBrowserSessionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-456' }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.any(String),
      }),
    );
  });

  test('returns error for unknown action', async () => {
    const result = await handler({
      action: 'unknown' as any,
      url: 'https://example.com',
    });

    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('unknown'),
      }),
    );
  });
});
