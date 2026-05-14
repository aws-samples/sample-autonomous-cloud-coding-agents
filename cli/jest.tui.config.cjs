/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Separate Jest config for the TUI panel tests. These need the real
 * Ink runtime (which is pure ESM), so we opt them into Jest's
 * experimental VM-modules ESM path. Run with:
 *
 *   NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.tui.config.cjs
 *
 * The main Jest config keeps CommonJS + `moduleNameMapper` for the
 * bulk of the test suite; only panel tests that actually mount Ink
 * components go through this config.
 */
module.exports = {
  rootDir: '.',
  testMatch: ['<rootDir>/test/tui-panels/**/*.test.@(ts|tsx)'],
  testPathIgnorePatterns: ['/node_modules/'],
  // Strip the `.js` suffix TUI sources use (Node16 ESM style) so
  // Jest's resolver finds the `.ts` / `.tsx` sources.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  transform: {
    '^.+\\.[jt]sx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.dev.json',
        useESM: true,
      },
    ],
  },
  // Ink + ink-testing-library are ESM; Jest's default transformIgnorePatterns
  // skips node_modules, so we whitelist the ones we need compiled.
  transformIgnorePatterns: [
    'node_modules/(?!(ink|ink-testing-library|chalk|cli-truncate|slice-ansi|string-width|strip-ansi|ansi-regex|ansi-styles|figures|is-fullwidth-code-point|emoji-regex|code-excerpt|indent-string|cli-cursor|cli-boxes|restore-cursor|widest-line|wrap-ansi|type-fest|auto-bind|yoga-layout|@alcalzone/ansi-tokenize|is-unicode-supported|is-in-ci|signal-exit|terminal-size|tagged-tag|xml-naming|uuid)/)',
  ],
  testEnvironment: 'node',
  clearMocks: true,
  // Coverage off for panel smokes — the coverage gate in the main config
  // already covers the pure logic; panels are about interaction, not
  // line-coverage gain.
  collectCoverage: false,
  // Ink keeps terminal-size polling + raw-mode listeners alive after
  // unmount in ways that leak into Jest's worker. We `forceExit` so the
  // suite doesn't hang for the 5 s default. Tests themselves assert all
  // behaviour before that point; `forceExit` only affects post-pass
  // teardown.
  forceExit: true,
};
