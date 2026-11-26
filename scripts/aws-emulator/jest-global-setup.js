const https = require('node:https');
const net = require('node:net');

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
    request.on('timeout', () => request.destroy(new Error('no answer within 3 s')));
    request.on('error', (error) => reject(refuse(error.message)));
  });
};
