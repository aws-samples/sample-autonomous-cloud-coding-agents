/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import stylistic from '@stylistic/eslint-plugin';
import importX from 'eslint-plugin-import-x';
import jest from 'eslint-plugin-jest';
import jsdoc from 'eslint-plugin-jsdoc';
import licenseHeader from 'eslint-plugin-license-header';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TS_FILES = ['src/**/*.ts', 'test/**/*.ts', 'build-tools/**/*.ts'];

const NO_MD5 = {
  selector: "CallExpression:matches([callee.name='createHash'], [callee.property.name='createHash']) Literal[value='md5']",
  message: 'Use the md5hash() function from the core library if you want md5',
};
// The name exception is this package's own REST client, which is not an SDK client.
const NO_NAKED_SDK_CLIENT = {
  selector: 'NewExpression:matches([callee.name=/^(?!ApiClient$).*Client$/], [callee.property.name=/Client$/])',
  message: 'Build AWS SDK clients with makeClient(Ctor, cfg) or makeDocClient(cfg) from src/ua.ts: `new XxxClient()` drops the'
    + ' solution user-agent segment (#319). For a class of this repository whose name merely ends in Client, add the name to'
    + ' the exception in this selector.',
};

export default [
  // Global ignores
  {
    ignores: [
      '**/*.js',
      '**/*.d.ts',
      '**/node_modules/',
      '**/*.generated.ts',
      '**/coverage/',
      '!eslint.config.mjs',
    ],
  },

  // Correctness baselines: eslint:recommended and the typescript-eslint recommended
  // set. They come before the package block so that block wins where both set a rule.
  { files: TS_FILES, rules: js.configs.recommended.rules },
  ...tseslint.configs['flat/recommended'].map((config) => ({ ...config, files: TS_FILES })),

  // TypeScript source, test, and build-tools files
  {
    files: TS_FILES,
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2018,
        sourceType: 'module',
        project: './tsconfig.dev.json',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      '@stylistic': stylistic,
      'import-x': importX,
      'jest': jest,
      'jsdoc': jsdoc,
      'license-header': licenseHeader,
    },
    settings: {
      'import-x/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import-x/resolver': {
        node: {},
        typescript: {
          project: './tsconfig.dev.json',
          alwaysTryTypes: true,
        },
      },
    },
    rules: {
      // Stylistic rules
      '@stylistic/indent': ['error', 2],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/comma-spacing': ['error', { before: false, after: true }],
      '@stylistic/no-multi-spaces': ['error', { ignoreEOLComments: false }],
      '@stylistic/array-bracket-spacing': ['error', 'never'],
      '@stylistic/array-bracket-newline': ['error', 'consistent'],
      '@stylistic/object-curly-spacing': ['error', 'always'],
      '@stylistic/object-curly-newline': ['error', { multiline: true, consistent: true }],
      '@stylistic/object-property-newline': ['error', { allowAllPropertiesOnSameLine: true }],
      '@stylistic/keyword-spacing': ['error'],
      '@stylistic/brace-style': ['error', '1tbs', { allowSingleLine: true }],
      '@stylistic/space-before-blocks': ['error'],
      '@stylistic/member-delimiter-style': ['error'],
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/max-len': ['error', {
        code: 150,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreComments: true,
        ignoreRegExpLiterals: true,
      }],
      '@stylistic/quote-props': ['error', 'consistent-as-needed'],
      '@stylistic/key-spacing': ['error'],
      '@stylistic/no-multiple-empty-lines': ['error'],
      '@stylistic/no-trailing-spaces': ['error'],
      '@stylistic/no-extra-semi': ['error'],
      '@stylistic/spaced-comment': ['error', 'always', {
        exceptions: ['/', '*'],
        markers: ['/'],
      }],
      '@stylistic/padded-blocks': ['error', {
        classes: 'never',
        blocks: 'never',
        switches: 'never',
      }],

      // Core ESLint rules
      'curly': ['error', 'multi-line', 'consistent'],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-shadow': ['off'],
      'no-return-await': 'off',
      'dot-notation': ['error'],
      'no-bitwise': ['error'],
      'no-throw-literal': ['error'],
      // One fixed ceiling on cyclomatic complexity, the same number in cdk, cli and web.
      // A function above it is split, not exempted. The eslint-disable-next-line
      // directives in src mark the functions that were above it when it landed: they
      // must not grow. When a directive stops applying, as when its function comes to
      // fit, the eslint task (--fix) deletes it and eslint:check reports it as unused.
      'complexity': ['error', { max: 40 }],
      'quotes': ['error', 'single', { avoidEscape: true }],
      'comma-spacing': ['error', { before: false, after: true }],
      'no-multi-spaces': ['error', { ignoreEOLComments: false }],
      'array-bracket-spacing': ['error', 'never'],
      'array-bracket-newline': ['error', 'consistent'],
      'object-curly-spacing': ['error', 'always'],
      'object-curly-newline': ['error', { multiline: true, consistent: true }],
      'object-property-newline': ['error', { allowAllPropertiesOnSameLine: true }],
      'keyword-spacing': ['error'],
      'brace-style': ['error', '1tbs', { allowSingleLine: true }],
      'space-before-blocks': 'error',
      'eol-last': ['error', 'always'],
      'no-duplicate-imports': ['error'],
      'key-spacing': ['error'],
      'semi': ['error', 'always'],
      'quote-props': ['error', 'consistent-as-needed'],
      'no-multiple-empty-lines': ['error', { max: 1 }],
      'max-len': ['error', {
        code: 150,
        ignoreUrls: true,
        ignoreStrings: true,
        ignoreTemplateLiterals: true,
        ignoreComments: true,
        ignoreRegExpLiterals: true,
      }],
      'no-console': ['error'],
      'no-trailing-spaces': ['error'],
      'no-restricted-syntax': ['error', NO_MD5],
      // Rules of the recommended sets that still have findings. Each one stays off
      // until its findings are fixed; delete the line to turn the rule on.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      // Off for good: its one finding is the pattern that strips ANSI escape codes.
      'no-control-regex': 'off',

      // TypeScript rules
      // Dead-code parity with Python ruff F401 (#282): unused imports/locals/params
      // are errors. `^_` opts out an intentionally-unused binding. Base rule must be
      // off so the typescript-eslint variant (type-aware) is the only one active.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        args: 'all',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        destructuredArrayIgnorePattern: '^_',
      }],
      // AI007 guard (#258): inline numeric literals should be named constants.
      // Values shared across Python/TypeScript belong in contracts/constants.json
      // (see contracts/constants.md).
      '@typescript-eslint/no-magic-numbers': ['error', {
        ignore: [
          // Identity / trivial arithmetic
          -1, 0, 1, 2,
          // Radix, percentages, and well-known unit conversions
          10, 24, 60, 100, 1000, 1024, 3600, 86400,
          // HTTP status codes (600 = exclusive upper bound for 5xx checks)
          200, 201, 202, 204, 301, 302, 304,
          400, 401, 403, 404, 409, 422, 429,
          500, 502, 503, 504, 600,
        ],
        ignoreEnums: true,
        ignoreNumericLiteralTypes: true,
        ignoreReadonlyClassProperties: true,
        ignoreTypeIndexes: true,
        ignoreDefaultValues: true,
        ignoreClassFieldInitialValues: true,
        ignoreArrayIndexes: true,
      }],
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-floating-promises': ['error'],
      '@typescript-eslint/return-await': 'error',
      '@typescript-eslint/member-ordering': ['error', {
        default: [
          'public-static-field',
          'public-static-method',
          'protected-static-field',
          'protected-static-method',
          'private-static-field',
          'private-static-method',
          'field',
          'constructor',
          'method',
        ],
      }],
      '@typescript-eslint/unbound-method': 'error',
      // Promise and operator misuse that compiles (type-aware rules).
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',

      // Import rules (import/ -> import-x/)
      'import-x/no-extraneous-dependencies': ['error', {
        devDependencies: ['**/test/**', '**/build-tools/**'],
        optionalDependencies: false,
        peerDependencies: true,
      }],
      'import-x/no-unresolved': ['error'],
      'import-x/order': ['error', {
        groups: ['builtin', 'external'],
        alphabetize: { order: 'asc', caseInsensitive: true },
      }],
      'import-x/no-duplicates': ['error'],
      // Runtime import cycles; `import type` edges do not count.
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',

      // License header
      'license-header/header': ['error', join(__dirname, 'header.js')],

      // JSDoc rules
      'jsdoc/require-param-description': ['error'],
      'jsdoc/require-property-description': ['error'],
      'jsdoc/require-returns-description': ['error'],
      'jsdoc/check-alignment': ['error'],

      // Jest rules
      'jest/expect-expect': 'off',
      'jest/no-conditional-expect': 'off',
      'jest/no-standalone-expect': 'off',
      'jest/valid-expect': 'off',
      'jest/valid-title': 'off',
      'jest/no-identical-title': 'off',
      'jest/no-disabled-tests': 'error',
      'jest/no-focused-tests': 'error',
      'jest/no-alias-methods': 'error',
      'jest/no-deprecated-functions': 'error',
      'jest/no-done-callback': 'error',
      'jest/no-duplicate-hooks': 'error',
      'jest/no-export': 'error',
      'jest/no-interpolation-in-snapshots': 'error',
      // Jest has no `fail()`: the call is a ReferenceError, which the catch block of
      // a try/fail/catch test swallows, so the test passes when nothing throws.
      'jest/no-jasmine-globals': 'error',
      'jest/no-mocks-import': 'error',
      'jest/no-test-prefixes': 'error',
      'jest/valid-describe-callback': 'error',
      'jest/valid-expect-in-promise': 'error',
    },
  },

  // Override: allow console.log in CLI source files (console output is the product)
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'off',
      // Every AWS SDK client in src is built by the attributed factory (#319). The whole
      // list again: a later block replaces a rule's options.
      'no-restricted-syntax': ['error', NO_MD5, NO_NAKED_SDK_CLIENT],
    },
  },

  // Override: tests and build tooling legitimately use inline literals
  {
    files: ['test/**/*.ts', 'build-tools/**/*.ts'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },

  // Override: shebang files can't have the license header at line 1
  {
    files: ['src/bin/**/*.ts'],
    rules: {
      'license-header/header': 'off',
    },
  },
];
