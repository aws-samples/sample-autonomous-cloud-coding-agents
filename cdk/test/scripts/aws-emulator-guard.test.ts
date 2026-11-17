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

/**
 * Tests for the guard of the emulator-backed tests (`scripts/aws-emulator/`).
 *
 * Those tests make real AWS SDK calls, so three files stand between them and a real
 * account: `jest-config.js` refuses an AWS environment that is not the emulator's,
 * `jest-global-setup.js` refuses a preload that is missing or refuses nothing and an
 * endpoint that is not an emulator, and `loopback-only.cjs` refuses a connection that
 * leaves the machine. A guard that stops refusing lets every emulator test pass, so the
 * refusals are made to happen here. Three of `jest-global-setup.js` are not: a certificate
 * it does not trust and a wrong answer on the health route, which need a TLS listener, and
 * an endpoint that never answers, which takes three seconds.
 *
 * Every case runs the real file in a child `node` whose whole environment is what the
 * case names: the shell that starts jest may export a real AWS profile. No case can
 * send anything off the machine even when the guard under test is broken: there are no
 * credentials, the endpoints are loopback ports, and the hosts are 127.0.0.2 or
 * `.invalid` names that no resolver is asked about.
 *
 * Neither an emulator nor Docker is needed, so this runs with the unit suite (same
 * placement rationale as `check-constants-sync.test.ts`). The accepting path, a real
 * emulator answering its health route, is exercised by every `mise run test:integration`.
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const GUARD = path.join(REPO_ROOT, 'scripts/aws-emulator');
const JEST_CONFIG = path.join(GUARD, 'jest-config.js');
const GLOBAL_SETUP = path.join(GUARD, 'jest-global-setup.js');
const PRELOAD = path.join(GUARD, 'loopback-only.cjs');

/** The AWS variables `emulator.sh run` sets, and the only ones the guard accepts. Nothing listens on port 1. */
const WRAPPER_ENVIRONMENT = {
  AWS_ENDPOINT_URL: 'https://127.0.0.1:1',
  AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/emulator_credentials',
  AWS_CONFIG_FILE: '/nonexistent/config',
  AWS_CA_BUNDLE: '/nonexistent/ca.pem',
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_DISABLE_HOST_PREFIX_INJECTION: 'true',
  AWS_REGION: 'us-east-1',
  AWS_DEFAULT_REGION: 'us-east-1',
};

/** Run `node` with `args`. `env` is its whole environment: nothing is inherited. */
function node(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, args, { env, encoding: 'utf-8', timeout: 30_000 });
}

describe('emulator test guard', () => {
  // One `node` start per test, about 50 ms each.
  jest.setTimeout(60_000);

  describe('jest-config.js', () => {
    /** The global setup of the emulator configuration, built from a unit configuration that has one of its own. */
    const BUILD = `require(${JSON.stringify(JEST_CONFIG)})({ globalSetup: 'unit-setup' }).globalSetup`;

    test('accepts what the wrapper sets, and puts its own global setup in place of the unit one', () => {
      const result = node(['-p', BUILD], WRAPPER_ENVIRONMENT);

      expect(result).toMatchObject({ status: 0, stdout: `${GLOBAL_SETUP}\n`, stderr: '' });
    });

    test.each([
      'http://127.0.0.1:1', // not TLS
      'https://localhost:1', // a name, not the address
      'https://127.0.0.2:1', // another address
      'https://127.0.0.1:1@outside.invalid', // only begins like the emulator's: the host is outside.invalid
      'https://outside.invalid/https://127.0.0.1:1', // only ends like it
    ])('refuses the endpoint %s', (endpoint) => {
      const result = node(['-p', BUILD], { ...WRAPPER_ENVIRONMENT, AWS_ENDPOINT_URL: endpoint });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`(AWS_ENDPOINT_URL='${endpoint}')`);
    });

    test.each([
      'AWS_PROFILE', // a source of credentials
      'AWS_ENDPOINT_URL_DYNAMODB', // begins like an accepted name, and sends one service elsewhere
      'AWS_SDK_UA_APP_ID', // harmless in itself: whatever the wrapper does not set is refused
    ])('refuses %s beside what the wrapper sets', (stray) => {
      const result = node(['-p', BUILD], { ...WRAPPER_ENVIRONMENT, [stray]: 'anything' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`unexpected: ${stray})`);
    });

    test.each(['cdk', 'cli'])('%s/jest.emulator.config.js refuses a shell without the emulator environment', (workspace) => {
      const result = node([path.join(REPO_ROOT, workspace, 'jest.emulator.config.js')]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("(AWS_ENDPOINT_URL=''). Run them with: mise run test:integration");
    });
  });

  describe('jest-global-setup.js refuses to start a run', () => {
    /**
     * Runs the setup, as jest does, against a listener that answers the health route with the
     * emulator's own body and is not the emulator: it does not speak TLS, let alone with the
     * certificate of this run. The system resolver is taken out first, so that it is not asked
     * even if the preload under test lets the setup's own probe through.
     */
    const START = `
      const impostor = require('node:http').createServer((_request, response) => response.end('ok')).unref();
      impostor.listen(0, '127.0.0.1', async () => {
        require('node:dns').lookup = (_host, _options, callback) => callback(new Error('no name resolution here'));
        process.env.AWS_ENDPOINT_URL = 'https://127.0.0.1:' + impostor.address().port;
        await require(${JSON.stringify(GLOBAL_SETUP)})();
        console.log('accepted');
      });`;

    test('without the loopback-only preload', () => {
      const result = node(['-e', START], WRAPPER_ENVIRONMENT);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Error: Emulator tests need the loopback-only preload');
    });

    test('with a preload that refuses nothing', () => {
      // The name the setup looks for, on a connect that lets everything through.
      const nameOnly = `
        const net = require('node:net');
        const connect = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function loopbackOnlyConnect(...args) { return connect.apply(this, args); };`;

      const result = node(['-e', nameOnly + START], WRAPPER_ENVIRONMENT);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Error: Emulator tests need the loopback-only preload');
    });

    test('with a guard that is not the preload', () => {
      // Refuses the probe, under another name.
      const otherName = `
        const net = require('node:net');
        const connect = net.Socket.prototype.connect;
        net.Socket.prototype.connect = function someOtherGuard(...args) {
          if (typeof args[1] === 'string' && args[1] !== '127.0.0.1') throw new Error('refused by another guard');
          return connect.apply(this, args);
        };`;

      const result = node(['-e', otherName + START], WRAPPER_ENVIRONMENT);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Error: Emulator tests need the loopback-only preload');
    });

    test('on an endpoint that is some other local service', () => {
      const result = node(['--require', PRELOAD, '-e', START], WRAPPER_ENVIRONMENT);

      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/Error: No AWS Emulator at https:\/\/127\.0\.0\.1:\d+ \(/);
    });
  });

  describe('loopback-only.cjs', () => {
    /**
     * Tries each way out and reports how it ended. A refusal throws before the name is resolved,
     * so the resolver, which is replaced first by one that only counts, is never asked. Without
     * the guard an attempt ends in that resolver's error or at 127.0.0.2, and is abandoned at once.
     */
    const ATTEMPTS = `
      const net = require('node:net');
      const http = require('node:http');
      const tls = require('node:tls');
      const server = http.createServer((_request, response) => response.end('ok'));
      server.listen(0, '127.0.0.1', async () => {
        const report = { lookups: 0 };
        require('node:dns').lookup = (_host, _options, callback) => { report.lookups += 1; callback(new Error('no name resolution here')); };
        const attempt = (name, open) => {
          try {
            open().on('error', () => undefined).destroy();
            report[name] = 'not refused';
          } catch (error) {
            report[name] = error.message;
          }
        };
        attempt('net.connect', () => net.connect({ host: 'outside.invalid', port: 443 }));
        attempt('http.get', () => http.get({ host: 'outside.invalid' }));
        attempt('tls.connect', () => tls.connect({ host: 'outside.invalid', port: 443 }));
        attempt('socket.connect', () => new net.Socket().connect(80, '127.0.0.2'));
        report.fetch = await fetch('http://outside.invalid/').then(() => 'not refused', (error) => String(error.cause?.message));
        report.loopback = await (await fetch('http://127.0.0.1:' + server.address().port)).text();
        server.close();
        console.log(JSON.stringify(report));
      });`;

    test('refuses every host but loopback, before the name is resolved', () => {
      const refused = (host: string) => expect.stringContaining(`and this one tried to reach ${host}.`);

      const result = node(['--require', PRELOAD, '-e', ATTEMPTS]);

      expect(result).toMatchObject({ status: 0, stderr: '' });
      expect(JSON.parse(result.stdout)).toEqual({
        'net.connect': refused('outside.invalid'),
        'http.get': refused('outside.invalid'),
        'tls.connect': refused('outside.invalid'),
        'socket.connect': refused('127.0.0.2'),
        'fetch': refused('outside.invalid'),
        'lookups': 0,
        // Loopback stays open: that is where the emulator is.
        'loopback': 'ok',
      });
    });
  });
});
