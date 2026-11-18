// Emulator-backed CLI tests (test/emulator/*.emulator.ts). Run with `mise run test:integration`.
module.exports = require('../scripts/aws-emulator/jest-config')(require('./package.json').jest);
