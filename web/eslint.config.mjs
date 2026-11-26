import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import licenseHeader from 'eslint-plugin-license-header';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TEST_FN = '/^(it|test|describe|suite)$/';
const TEST_MODIFIER = '/^(skip|only|todo|fails|skipIf|runIf)$/';
const NO_DISABLED_TESTS = [
  `MemberExpression:matches([property.name=${TEST_MODIFIER}], [property.value=${TEST_MODIFIER}])`
    + `:matches(:has(Identifier.object[name=${TEST_FN}]), CallExpression > .callee)`,
  // vitest's test context has skip(): it('name', ({ skip }) => { skip(); ... }).
  "CallExpression[callee.name='skip']",
  // vitest takes the same modifiers as options: it('name', { skip: true }, fn).
  `CallExpression:matches([callee.name=${TEST_FN}], :has(> .callee:has(Identifier.object[name=${TEST_FN}])))`
    + ` > ObjectExpression.arguments > Property:matches([key.name=${TEST_MODIFIER}], [key.value=${TEST_MODIFIER}])`,
  // vitest treats a test or suite without a function as a todo: it('name'), it('name', { timeout: 5 }).
  `CallExpression[callee.name=${TEST_FN}]:matches([arguments.length=1], :has(> ObjectExpression.arguments:last-child))`,
].map((selector) => ({
  selector,
  message: 'A skipped, focused, todo or expected-to-fail test must not be committed: make the test pass or delete it.',
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

for (const dir of ['src/core', 'src/domains', 'src/mocks', 'test']) {
  if (!existsSync(join(__dirname, dir))) {
    throw new Error(`web/eslint.config.mjs: ${dir} does not exist; update the import boundary rules.`);
  }
}
const MOCKS_MESSAGE = 'src/mocks may be loaded only through import() inside `if (__MOCK__) { ... }`, as main.tsx does,'
  + ' and by tests: mock sign-in must never reach a production bundle.';
const DOMAINS_MESSAGE = 'src/core must not import from src/domains: move what both need into core.';
const NO_CLOUDSCAPE_BARREL = {
  name: '@cloudscape-design/components',
  message: 'Import each Cloudscape component from its own module: @cloudscape-design/components/<name>.',
};
const NO_MOCKS = { regex: '(^|/)mocks(/|$)', message: MOCKS_MESSAGE };
const NO_DOMAINS = { regex: '(^|/)domains(/|$)', message: DOMAINS_MESSAGE };
// no-restricted-imports does not look at import().
const NO_DYNAMIC_MOCKS = {
  selector: "ImportExpression[source.value=/(^|\\/)mocks(\\/|$)/]:not(IfStatement[test.name='__MOCK__'] > .consequent ImportExpression)",
  message: MOCKS_MESSAGE,
};
const NO_DYNAMIC_DOMAINS = { selector: 'ImportExpression[source.value=/(^|\\/)domains(\\/|$)/]', message: DOMAINS_MESSAGE };
const TEST_MESSAGE = 'src must not import from test/: the helpers there load the mock data, which must never reach a production bundle.';
const NO_TEST = { regex: '(^|/)test(/|$)', message: TEST_MESSAGE };
const NO_DYNAMIC_TEST = { selector: 'ImportExpression[source.value=/(^|\\/)test(\\/|$)/]', message: TEST_MESSAGE };
const NO_COMPUTED_IMPORT = {
  selector: "ImportExpression[source.type!='Literal']",
  message: 'Give import() a string literal: lint checks that path against the import boundaries, and vite bundles every file a computed one can reach.',
};
const NO_GLOB_IMPORT = {
  selector: "MemberExpression[object.type='MetaProperty'][property.name='glob']",
  message: 'Do not use import.meta.glob in src: a pattern can pull src/mocks into the production bundle. Import each module by name.',
};

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '**/*.js'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  {
    // The typescript-eslint preset also matches .mts and .cts.
    files: ['src/**/*.{ts,tsx,mts,cts}', 'test/**/*.{ts,tsx,mts,cts}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: __dirname } },
    plugins: { 'license-header': licenseHeader },
    rules: {
      'license-header/header': ['error', join(__dirname, 'header.js')],
      // The coverage-ignore spellings that jest (v8-to-istanbul) and vitest honour.
      'no-warning-comments': ['error', { terms: ['istanbul ignore', 'c8 ignore', 'v8 ignore', 'node:coverage'], location: 'anywhere' }],
      'eqeqeq': ['error', 'always'],
      'complexity': ['error', { max: 40 }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // The react-hooks preset only warns for these three.
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/incompatible-library': 'error',
      'react-hooks/unsupported-syntax': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/return-await': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',
    },
  },
  {
    files: ['src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [NO_CLOUDSCAPE_BARREL], patterns: [NO_MOCKS, NO_TEST] }],
      'no-restricted-syntax': ['error', NO_DYNAMIC_MOCKS, NO_DYNAMIC_TEST, NO_COMPUTED_IMPORT, NO_GLOB_IMPORT],
    },
  },
  {
    // ESLint replaces the options of a rule in a later block: it does not merge them.
    files: ['src/core/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [NO_CLOUDSCAPE_BARREL], patterns: [NO_MOCKS, NO_TEST, NO_DOMAINS] }],
      'no-restricted-syntax': ['error', NO_DYNAMIC_MOCKS, NO_DYNAMIC_TEST, NO_COMPUTED_IMPORT, NO_GLOB_IMPORT, NO_DYNAMIC_DOMAINS],
    },
  },
  {
    files: ['test/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_DISABLED_TESTS],
    },
  },
);
