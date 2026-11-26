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

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handler } from '../../src/handlers/get-trace-url';

if (!/^https:\/\/127\.0\.0\.1:\d+$/.test(process.env.AWS_ENDPOINT_URL ?? '')) {
  throw new Error('trace-api-shim serves only against an AWS Emulator (AWS_ENDPOINT_URL=https://127.0.0.1:<port>).');
}

const TRACE_ROUTE = /^\/tasks\/([^/]+)\/trace$/;

const server = createServer((req, res) => {
  const match = TRACE_ROUTE.exec(new URL(req.url ?? '/', 'http://shim').pathname);
  if (req.method !== 'GET' || !match) {
    res.writeHead(404).end();
    return;
  }
  const caller = req.headers['x-api-key'];
  const event = {
    httpMethod: 'GET',
    path: req.url,
    headers: req.headers,
    pathParameters: { task_id: decodeURIComponent(match[1]) },
    requestContext: {
      // API Gateway's Cognito authorizer puts the verified caller in `claims.sub`.
      authorizer: typeof caller === 'string' ? { claims: { sub: caller } } : undefined,
    },
  };
  handler(event as never).then(
    (result) => res.writeHead(result.statusCode, result.headers as Record<string, string>).end(result.body),
    (err: unknown) => res.writeHead(500).end(String(err)),
  );
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`);
});
