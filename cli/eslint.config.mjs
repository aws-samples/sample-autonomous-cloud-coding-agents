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

// ESLint silently skips a file that no `files` pattern matches.
const TS_FILES = ['src/**/*.{ts,tsx,mts,cts}', 'test/**/*.{ts,tsx,mts,cts}'];

const NO_MD5 = {
  selector: "CallExpression:matches([callee.name='createHash'], [callee.property.name='createHash']) Literal[value='md5']",
  message: 'Use the md5hash() function from the core library if you want md5',
};
const NO_NAKED_SDK_CLIENT = {
  selector: 'NewExpression:matches([callee.name=/^(?!ApiClient$).*Client$/], [callee.property.name=/Client$/])',
  message: 'Build AWS SDK clients with makeClient(Ctor, cfg) or makeDocClient(cfg) from src/ua.ts: `new XxxClient()` drops the'
    + ' solution user-agent segment (#319). For a class of this repository whose name merely ends in Client, add the name to'
    + ' the exception in this selector.',
};
const NO_IMPORT_OUTSIDE_PACKAGE = 'The CLI ships only lib/, compiled from cli/src: a file outside the cli package is not part of an'
  + ' installed CLI. Mirror an API type or constant of the CDK in src/types.ts, which `mise run check:types-sync` compares with the'
  + ' CDK declaration. Copy any other value into src and pin the copy with a parity test such as test/constants-parity.test.ts.';

export default [
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

  { files: TS_FILES, rules: js.configs.recommended.rules },
  ...tseslint.configs['flat/recommended'].map((config) => ({ ...config, files: TS_FILES })),

  {
    files: TS_FILES,
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2018,
        sourceType: 'module',
        project: './tsconfig.dev.json',
        // Without this, a run without --fix parses the copy on disk, where a shebang is not a
        // comment, and license-header reports the header of src/bin/bgagent.ts as misplaced (#172).
        disallowAutomaticSingleRunInference: true,
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
      '@stylistic/indent': ['error', 2],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/comma-spacing': ['error', { before: false, after: true }],
      '@stylistic/no-multi-spaces': ['error', { ignoreEOLComments: false, exceptions: { Property: true, ImportAttribute: false } }],
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
      '@stylistic/no-multiple-empty-lines': ['error', { max: 1 }],
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

      'curly': ['error', 'multi-line', 'consistent'],
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-shadow': ['off'],
      'no-return-await': 'off',
      'dot-notation': ['error'],
      'no-bitwise': ['error'],
      'no-throw-literal': ['error'],
      'complexity': ['error', { max: 40 }],
      // The @stylistic forks of these two rules leave checks out: the space in `catch (`, and the space
      // after the comma of an array hole (`[, second]`) and at the trailing comma of a type parameter list.
      'comma-spacing': ['error', { before: false, after: true }],
      'keyword-spacing': ['error'],
      'eol-last': ['error', 'always'],
      'no-duplicate-imports': ['error'],
      'no-console': ['error'],
      'no-warning-comments': ['error', { terms: ['istanbul ignore', 'c8 ignore', 'v8 ignore', 'node:coverage'], location: 'anywhere' }],
      'no-restricted-syntax': ['error', NO_MD5],
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',

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
      '@typescript-eslint/no-magic-numbers': ['error', {
        ignore: [
          -1, 0, 1, 2,
          10, 24, 60, 100, 1000, 1024, 3600, 86400,
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
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-unsafe-unary-minus': 'error',
      '@typescript-eslint/restrict-plus-operands': 'error',

      'import-x/no-extraneous-dependencies': ['error', {
        devDependencies: ['**/test/**'],
        optionalDependencies: false,
        peerDependencies: true,
      }],
      'import-x/no-unresolved': ['error'],
      'import-x/order': ['error', {
        groups: ['builtin', 'external'],
        alphabetize: { order: 'asc', caseInsensitive: true },
      }],
      'import-x/no-duplicates': ['error'],
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',

      'license-header/header': ['error', join(__dirname, 'header.js')],

      'jsdoc/require-param-description': ['error'],
      'jsdoc/require-property-description': ['error'],
      'jsdoc/require-returns-description': ['error'],
      'jsdoc/check-alignment': ['error'],

      'jest/expect-expect': 'error',
      'jest/no-conditional-expect': 'off',
      'jest/no-standalone-expect': 'error',
      'jest/valid-expect': 'error',
      'jest/valid-title': 'off',
      'jest/no-identical-title': 'error',
      'jest/no-disabled-tests': 'error',
      'jest/no-focused-tests': 'error',
      'jest/no-alias-methods': 'error',
      'jest/no-deprecated-functions': 'error',
      'jest/no-done-callback': 'error',
      'jest/no-duplicate-hooks': 'error',
      'jest/no-export': 'error',
      'jest/no-interpolation-in-snapshots': 'error',
      'jest/no-jasmine-globals': 'error',
      'jest/no-mocks-import': 'error',
      'jest/no-test-prefixes': 'error',
      'jest/valid-describe-callback': 'error',
      'jest/valid-expect-in-promise': 'error',
    },
  },

  {
    files: ['src/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-console': 'off',
      // The whole list again: a later block replaces a rule's options.
      'no-restricted-syntax': ['error', NO_MD5, NO_NAKED_SDK_CLIENT],
      'import-x/no-restricted-paths': ['error', {
        basePath: __dirname,
        zones: [
          { target: './src', from: '..', except: ['./cli', './node_modules'], message: NO_IMPORT_OUTSIDE_PACKAGE },
          { target: './src', from: '../node_modules/@abca', except: ['./cli'], message: NO_IMPORT_OUTSIDE_PACKAGE },
        ],
      }],
    },
  },

  {
    files: ['test/**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
    },
  },
];
