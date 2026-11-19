// Builds the jest configuration for a package's emulator-backed tests (ADR-013 Tier 2a) from that
// package's own unit-test configuration. Used by cdk/jest.emulator.config.js and
// cli/jest.emulator.config.js; run through `mise run test:integration`.
//
// The tests are named *.emulator.ts, which the unit configurations' testMatch does not match, so
// a unit run cannot pick them up. They make real AWS SDK calls: with no endpoint set they would
// call AWS with whatever credentials the shell holds. So this refuses to produce a configuration
// unless the AWS environment is the one scripts/aws-emulator/emulator.sh builds, and the
// configuration it produces confirms, before any test file loads, that the loopback-only preload
// is in force and that the endpoint is that emulator (jest-global-setup.js).

const path = require('node:path');

const LOOPBACK_EMULATOR = /^https:\/\/127\.0\.0\.1:\d+$/;
// What emulator.sh sets. Anything else in the AWS_* namespace (a profile, keys, a per-service
// endpoint, AWS_IGNORE_CONFIGURED_ENDPOINT_URLS) could send a call somewhere other than the
// emulator, or sign it with real credentials.
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
  // A unit configuration may carry a globalSetup that strips the AWS environment so that unit
  // tests cannot reach AWS (the CLI's does, from #1035 on). That environment is what these tests
  // run on, so it is replaced; everything else is inherited.
  return {
    ...unitConfig,
    testMatch: ['<rootDir>/test/emulator/**/*.emulator.ts'],
    globalSetup: path.join(__dirname, 'jest-global-setup.js'),
    // Coverage thresholds are a property of the unit suite; a handful of files cannot meet them.
    collectCoverage: false,
    // The unit run's JUnit report lives in the same directory; do not overwrite it.
    reporters: ['default'],
  };
};
