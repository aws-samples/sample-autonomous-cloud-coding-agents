import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import licenseHeader from 'eslint-plugin-license-header';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import boundaries of web/AGENTS.md. They match directory names inside import paths,
// so a renamed directory would switch a rule off without a word: fail the run instead.
for (const dir of ['src/core', 'src/domains', 'src/mocks']) {
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
// no-restricted-imports does not look at import(), so the same two paths again.
const NO_DYNAMIC_MOCKS = {
  selector: "ImportExpression[source.value=/(^|\\/)mocks(\\/|$)/]:not(IfStatement[test.name='__MOCK__'] > .consequent ImportExpression)",
  message: MOCKS_MESSAGE,
};
const NO_DYNAMIC_DOMAINS = { selector: 'ImportExpression[source.value=/(^|\\/)domains(\\/|$)/]', message: DOMAINS_MESSAGE };

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '**/*.js'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  {
    // Every TypeScript extension here and below: the presets above also match .mts and
    // .cts, so such a file would be linted, but by none of the rules of this package.
    files: ['src/**/*.{ts,tsx,mts,cts}', 'test/**/*.{ts,tsx,mts,cts}'],
    // Type information for the type-aware rules below, from web/tsconfig.json.
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: __dirname } },
    plugins: { 'license-header': licenseHeader },
    rules: {
      'license-header/header': ['error', join(__dirname, 'header.js')],
      'eqeqeq': ['error', 'always'],
      // One fixed ceiling on cyclomatic complexity, the same number in cdk, cli and web.
      // A function above it is split, not exempted with a disable directive.
      'complexity': ['error', { max: 40 }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // The preset only warns for these three.
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/incompatible-library': 'error',
      'react-hooks/unsupported-syntax': 'error',
      // Promise and operator misuse that compiles (type-aware rules, as in cdk and cli).
      '@typescript-eslint/await-thenable': 'error',
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
      'no-restricted-imports': ['error', { paths: [NO_CLOUDSCAPE_BARREL], patterns: [NO_MOCKS] }],
      'no-restricted-syntax': ['error', NO_DYNAMIC_MOCKS],
    },
  },
  {
    // A later block replaces the options of a rule, so core repeats the lists in full.
    files: ['src/core/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', { paths: [NO_CLOUDSCAPE_BARREL], patterns: [NO_MOCKS, NO_DOMAINS] }],
      'no-restricted-syntax': ['error', NO_DYNAMIC_MOCKS, NO_DYNAMIC_DOMAINS],
    },
  },
  {
    files: ['test/**/*.{ts,tsx,mts,cts}'],
    rules: {
      // What jest/no-disabled-tests and jest/no-focused-tests do in cdk and cli.
      'no-restricted-syntax': ['error', {
        selector: 'MemberExpression[object.name=/^(it|test|describe|suite)$/][property.name=/^(skip|only|todo|fails|skipIf|runIf)$/]',
        message: 'A skipped, focused, todo or expected-to-fail test must not be committed: make the test pass or delete it.',
      }],
    },
  },
);
