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
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import stylistic from '@stylistic/eslint-plugin';
import * as cdklabs from '@cdklabs/eslint-plugin';
import importX from 'eslint-plugin-import-x';
import jest from 'eslint-plugin-jest';
import jsdoc from 'eslint-plugin-jsdoc';
import licenseHeader from 'eslint-plugin-license-header';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default [
  // Global ignores
  {
    ignores: [
      '**/*.js',
      '**/*.d.ts',
      '**/node_modules/',
      '**/*.generated.ts',
      '**/coverage/',
      '**/cdk.out*/',
      '!eslint.config.mjs',
    ],
  },

  // TypeScript source, test, and scripts files
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
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
      '@cdklabs': cdklabs,
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
      'no-shadow': ['off'],
      'no-return-await': 'off',
      'dot-notation': ['error'],
      'no-bitwise': ['error'],
      'no-throw-literal': ['error'],
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
      'no-restricted-syntax': ['error', {
        selector: "CallExpression:matches([callee.name='createHash'], [callee.property.name='createHash']) Literal[value='md5']",
        message: 'Use the md5hash() function from the core library if you want md5',
      }],

      // TypeScript rules
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

      // CDK Labs rules
      // NOTE: The following 4 rules use context.getFilename() which was removed in ESLint 10.
      // They are disabled until @cdklabs/eslint-plugin adds ESLint 10 support.
      // Track: https://github.com/cdklabs/eslint-plugin/issues
      '@cdklabs/no-core-construct': ['off'],
      '@cdklabs/invalid-cfn-imports': ['off'],
      '@cdklabs/no-literal-partition': ['off'],
      '@cdklabs/no-invalid-path': ['off'],
      '@cdklabs/promiseall-no-unbounded-parallelism': ['error'],

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
      'jest/no-done-callback': 'off',
      'jest/no-standalone-expect': 'off',
      'jest/valid-expect': 'off',
      'jest/valid-title': 'off',
      'jest/no-identical-title': 'off',
      'jest/no-disabled-tests': 'error',
      'jest/no-focused-tests': 'error',
    },
  },
];
