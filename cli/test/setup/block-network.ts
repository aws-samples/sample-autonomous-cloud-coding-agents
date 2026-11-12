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

import * as net from 'net';

/**
 * Jest setupFile: a test in this package cannot open a connection that leaves
 * the machine.
 *
 * ``isolate-environment.ts`` takes the developer's configuration and
 * credentials away. This closes what is left: a test that brings its own
 * region or URL and forgets to mock the client would still send a request.
 * Every way out (http, https, http2, fetch, the AWS SDK) ends in
 * ``net.Socket.connect``, so that is where it is refused, before a name is
 * resolved or a packet is sent. Loopback stays open for tests that start a
 * local server; pipes are untouched.
 *
 * When a test fails here, mock the client or ``fetch`` call that tried to
 * connect. Do not add hosts to the list.
 */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** The TCP host a ``connect`` call targets, or undefined for a pipe. */
function tcpHost(args: unknown[]): string | undefined {
  // net.connect() hands over one normalized [options, listener] array, socket.connect() the caller's arguments.
  const [first, second] = Array.isArray(args[0]) ? args[0] as unknown[] : args;
  if (typeof first === 'object' && first !== null) {
    // http's agent passes ``path: null`` for TCP; like node, only a non-empty path means a pipe.
    const { path, host } = first as { path?: string | null; host?: string | null };
    return path ? undefined : host || 'localhost';
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return undefined;
  return typeof second === 'string' && second ? second : 'localhost';
}

// ``net`` is a core module, shared by every test file a worker runs: patch it once.
const patched = Symbol.for('bgagent.cli.test.block-network');
const socket = net.Socket.prototype as net.Socket & { [patched]?: boolean };

if (!socket[patched]) {
  const connect = Reflect.get(socket, 'connect') as (this: net.Socket, ...args: unknown[]) => net.Socket;
  socket.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    const host = tcpHost(args);
    if (host !== undefined && !LOOPBACK.has(host)) {
      throw new Error(`cli tests must not open network connections, and this one tried to reach ${host}. `
        + 'Mock the client or fetch call that sends the request (see test/setup/block-network.ts).');
    }
    return connect.apply(this, args);
  } as typeof socket.connect;
  socket[patched] = true;
}
