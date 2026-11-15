// Preloaded into every Node process that emulator.sh starts (NODE_OPTIONS=--require): jest and
// its workers, tsx, the bgagent CLI. A child process gets it through the inherited NODE_OPTIONS,
// so one started with an environment of its own does not.
//
// The emulator tests make real network calls, and the only place they may go is this machine.
// The environment points the AWS SDK at the emulator; it does not govern anything else. Product
// code also calls GitHub, Slack, Linear and Jira, fetches a token-verification key set from the
// real Cognito host, and opens a hand-signed WebSocket, none of which follow AWS_ENDPOINT_URL.
// Every TCP connection out of a Node process (http, https, http2, fetch, WebSocket, the AWS SDK)
// goes through net.Socket.connect, so that is where one that would leave the machine is refused,
// before a name is resolved or a packet is sent. Pipes are untouched. UDP (node:dgram) does not
// pass through here and is not covered; no ABCA code uses it.
//
// The refusal reaches the caller as an ordinary network error. A test of code that swallows
// network errors therefore has to assert that no request was attempted.
//
// When a test fails here, stub the call that tried to connect. Do not add hosts to the list.
// jest-global-setup.js checks, by this function's name and by a refused probe, that this is loaded.
'use strict';

const net = require('node:net');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The TCP host a connect call targets, or undefined for a pipe. */
function tcpHost(args) {
  // net.connect() hands over one normalized [options, listener] array, socket.connect() the caller's arguments.
  const [first, second] = Array.isArray(args[0]) ? args[0] : args;
  if (typeof first === 'object' && first !== null) {
    // http's agent passes `path: null` for TCP; like node, only a non-empty path means a pipe.
    return first.path ? undefined : first.host || 'localhost';
  }
  if (typeof first === 'string' && Number.isNaN(Number(first))) return undefined;
  return typeof second === 'string' && second ? second : 'localhost';
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function loopbackOnlyConnect(...args) {
  const host = tcpHost(args);
  if (host !== undefined && !LOOPBACK.has(host)) {
    throw new Error(
      `Emulator tests must not open a connection that leaves this machine, and this one tried to reach ${host}. ` +
      'Stub the call that sends the request (see scripts/aws-emulator/loopback-only.cjs).',
    );
  }
  return connect.apply(this, args);
};
