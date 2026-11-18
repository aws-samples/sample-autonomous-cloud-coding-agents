// Jest globalSetup for the emulator-backed tests: runs once, before any test file is loaded, and
// stops the run unless two things hold.
//
// 1. loopback-only.cjs is preloaded and refuses a connection that leaves this machine. The
//    environment only says where AWS SDK calls go; that preload is what keeps everything else
//    (and an SDK client a profile setting has pointed back at AWS) on this machine.
// 2. The endpoint really is the AWS Emulator this environment belongs to. Only an emulator answers
//    `ok` on /__admin/health, and only the one that wrote the certificate named by
//    NODE_EXTRA_CA_CERTS passes the TLS handshake. A loopback address that is some other local
//    service fails here instead of receiving a suite's CreateTable calls.
//
// Deliberately free of dependencies: this file belongs to no package.

const https = require('node:https');
const net = require('node:net');

/** True when the preload is in force. Sends nothing either way: with the preload, connect throws before the name is resolved. */
function loopbackOnly() {
  if (net.Socket.prototype.connect.name !== 'loopbackOnlyConnect') return false;
  const probe = new net.Socket();
  try {
    probe.connect(443, 'loopback-guard-check.invalid');
    return false;
  } catch {
    return true;
  } finally {
    probe.destroy();
  }
}

module.exports = function requireEmulator() {
  if (!loopbackOnly()) {
    throw new Error(
      'Emulator tests need the loopback-only preload (scripts/aws-emulator/loopback-only.cjs), and it is not in force. ' +
      'Run them with: mise run test:integration',
    );
  }
  const endpoint = process.env.AWS_ENDPOINT_URL;
  const refuse = (why) => new Error(`No AWS Emulator at ${endpoint} (${why}). Start one with: mise run emulator:up`);
  return new Promise((resolve, reject) => {
    const request = https.get(`${endpoint}/__admin/health`, { timeout: 3000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode === 200 && body.trim() === 'ok') resolve();
        else reject(refuse(`its health route answered ${response.statusCode}`));
      });
    });
    // An endpoint that accepts and never answers fails in seconds, not at a test's timeout.
    request.on('timeout', () => request.destroy(new Error('no answer within 3 s')));
    request.on('error', (error) => reject(refuse(error.message)));
  });
};
