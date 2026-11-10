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

import * as http from 'http';
import * as net from 'net';

/**
 * What ``test/setup/block-network.ts`` guarantees to every test file.
 *
 * If the first group fails, the ``jest.setupFiles`` entry in package.json no
 * longer loads that module: restore it. The targets are chosen so that these
 * tests send nothing even then: a name that is resolved by a ``lookup`` which
 * fails, and 127.0.0.2, which the guard does not allow and which cannot leave
 * the machine.
 */
const refused = (host: string) => new RegExp(`cli tests must not open network connections, and this one tried to reach ${host}\\.`);
const UNRESOLVED = 'outside.invalid';
const UNLISTED = '127.0.0.2';

describe('network guard', () => {
  describe('refuses every host but loopback, before the name is resolved', () => {
    const lookup = jest.fn<void, Parameters<net.LookupFunction>>((_hostname, _options, callback) => {
      callback(new Error('no name resolution in tests'), '', 4);
    });
    /** Swallow the asynchronous error the attempt ends in when the guard is missing. */
    const quiet = (emitter: { on(event: 'error', listener: () => void): unknown }): void => {
      emitter.on('error', () => undefined);
    };

    afterEach(() => expect(lookup).not.toHaveBeenCalled());

    test('net.connect with options', () => {
      expect(() => quiet(net.connect({ host: UNRESOLVED, port: 443, lookup }))).toThrow(refused(UNRESOLVED));
    });

    test('an http request', () => {
      expect(() => quiet(http.get({ host: UNRESOLVED, lookup }))).toThrow(refused(UNRESOLVED));
    });

    test('socket.connect with a port and a host', () => {
      const socket = new net.Socket();
      expect(() => quiet(socket.connect(80, UNLISTED))).toThrow(refused(UNLISTED));
      socket.destroy();
    });

    test('fetch', async () => {
      const request = fetch(`http://${UNLISTED}/`, { signal: AbortSignal.timeout(1000) });
      await expect(request).rejects.toMatchObject({ cause: { message: expect.stringMatching(refused(UNLISTED)) } });
    });
  });

  test('leaves loopback open', async () => {
    const server = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      expect(await response.text()).toBe('ok');
    } finally {
      server.close();
    }
  });
});
