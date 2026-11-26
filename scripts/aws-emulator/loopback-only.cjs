// Every TCP connection out of a Node process (http, https, http2, fetch, WebSocket, the AWS SDK)
// goes through net.Socket.connect. UDP (node:dgram) does not, nor does a name that code resolves
// itself (node:dns).
'use strict';

const net = require('node:net');

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

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
