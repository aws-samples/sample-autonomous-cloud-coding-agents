const path = require('node:path');

const LOOPBACK_EMULATOR = /^https:\/\/127\.0\.0\.1:\d+$/;
const EXPECTED = new Set([
  'AWS_ENDPOINT_URL', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_CA_BUNDLE',
  'AWS_EC2_METADATA_DISABLED', 'AWS_DISABLE_HOST_PREFIX_INJECTION', 'AWS_REGION', 'AWS_DEFAULT_REGION',
]);

module.exports = function emulatorConfig(unitConfig) {
  const endpoint = process.env.AWS_ENDPOINT_URL ?? '';
  const strays = Object.keys(process.env).filter((name) => name.startsWith('AWS_') && !EXPECTED.has(name));
  if (!LOOPBACK_EMULATOR.test(endpoint) || strays.length > 0) {
    throw new Error(
      `Emulator tests need AWS_ENDPOINT_URL=https://127.0.0.1:<port> and no other AWS configuration ` +
      `(AWS_ENDPOINT_URL='${endpoint}'${strays.length > 0 ? `; unexpected: ${strays.join(', ')}` : ''}). ` +
      'Run them with: mise run test:integration',
    );
  }
  return {
    ...unitConfig,
    testMatch: ['<rootDir>/test/emulator/**/*.emulator.ts'],
    globalSetup: path.join(__dirname, 'jest-global-setup.js'),
    collectCoverage: false,
    reporters: ['default'],
  };
};
