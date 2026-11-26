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
import * as cdklabs from '@cdklabs/eslint-plugin';
import importX from 'eslint-plugin-import-x';
import jest from 'eslint-plugin-jest';
import jsdoc from 'eslint-plugin-jsdoc';
import licenseHeader from 'eslint-plugin-license-header';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ESLint skips, without a word, a file that no `files` pattern matches.
const TS_FILES = ['src/**/*.{ts,tsx,mts,cts}', 'test/**/*.{ts,tsx,mts,cts}', 'scripts/**/*.{ts,tsx,mts,cts}'];

const NO_MD5 = {
  selector: "CallExpression:matches([callee.name='createHash'], [callee.property.name='createHash']) Literal[value='md5']",
  message: 'Use the md5hash() function from the core library if you want md5',
};
// An AWS SDK client takes one config argument at most; a CDK construct such as
// cognito.UserPoolClient takes (scope, id, props).
const NO_NAKED_SDK_CLIENT = {
  selector: 'NewExpression[arguments.length<2]:matches('
    + '[callee.name=/^(?!AgentRegistryClient$).*Client$/], [callee.property.name=/Client$/])',
  message: 'Build AWS SDK clients with makeClient(Ctor, cfg) or makeDocClient(cfg) from src/handlers/shared/ua.ts: `new XxxClient()` drops the'
    + ' solution user-agent segment (#319). For a class of this repository whose name merely ends in Client, add the name to'
    + ' the exception in this selector.',
};

const NO_CDK_IN_HANDLERS = 'Lambda handler code is bundled with everything it imports, and a module that imports the CDK'
  + ' brings the whole library into the function. Inside cdk/src a handler may import only src/handlers and the two'
  + ' import-free modules constructs/task-status and constructs/task-table-indexes. Put a value both sides need in'
  + ' src/handlers/shared (see storage-names.ts) and import it from the construct.';

const HANDLER_IMPORT_ALLOW_LIST = ['./handlers', './constructs/task-status.ts', './constructs/task-table-indexes.ts'];
for (const allowed of HANDLER_IMPORT_ALLOW_LIST) {
  if (!existsSync(join(__dirname, 'src', allowed))) {
    throw new Error(`cdk/eslint.config.mjs: ${join('src', allowed)} does not exist; update the handler import rules.`);
  }
}

export default [
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
      '@stylistic/indent': ['error', 2],
      '@stylistic/quotes': ['error', 'single', { avoidEscape: true }],
      '@stylistic/comma-dangle': ['error', 'always-multiline'],
      '@stylistic/comma-spacing': ['error', { before: false, after: true }],
      // The plugin's default exceptions also let two spaces inside an import attribute pass.
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
      // A function above it is split, not exempted. The eslint-disable-next-line
      // directives in src mark the functions that were above it when it landed.
      'complexity': ['error', { max: 40 }],
      // These two core formatting rules stay on beside their @stylistic forks, which each
      // leave checks out: the space in `catch (`, and the space after the comma of an
      // array hole (`[, second]`) and at the trailing comma of a type parameter list.
      'comma-spacing': ['error', { before: false, after: true }],
      'keyword-spacing': ['error'],
      'eol-last': ['error', 'always'],
      'no-duplicate-imports': ['error'],
      'no-console': ['error'],
      // The coverage-ignore spellings that jest (v8-to-istanbul) and vitest honour.
      'no-warning-comments': ['error', { terms: ['istanbul ignore', 'c8 ignore', 'v8 ignore', 'node:coverage'], location: 'anywhere' }],
      'no-restricted-syntax': ['error', NO_MD5],
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-assignment': 'off',

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
        devDependencies: ['**/test/**', '**/scripts/**'],
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

      // These four rules call context.getFilename(), which ESLint 10 removed.
      '@cdklabs/no-core-construct': ['off'],
      '@cdklabs/invalid-cfn-imports': ['off'],
      '@cdklabs/no-literal-partition': ['off'],
      '@cdklabs/no-invalid-path': ['off'],
      '@cdklabs/promiseall-no-unbounded-parallelism': ['error'],

      'license-header/header': ['error', join(__dirname, 'header.js')],

      'jsdoc/require-param-description': ['error'],
      'jsdoc/require-property-description': ['error'],
      'jsdoc/require-returns-description': ['error'],
      'jsdoc/check-alignment': ['error'],

      // Every void method of Template and Annotations in aws-cdk-lib/assertions;
      // their find* and get* methods return a value.
      'jest/expect-expect': ['error', {
        assertFunctionNames: [
          'expect*',
          '**.resourceCountIs', '**.resourcePropertiesCountIs', '**.hasResource', '**.hasResourceProperties',
          '**.allResources', '**.allResourcesProperties', '**.hasParameter', '**.hasOutput', '**.hasMapping',
          '**.hasCondition', '**.templateMatches',
          '**.hasError', '**.hasNoError', '**.hasWarning', '**.hasNoWarning', '**.hasInfo', '**.hasNoInfo',
        ],
      }],
      'jest/no-conditional-expect': 'off',
      'jest/no-standalone-expect': ['error', { additionalTestBlockFunctions: ['afterEach'] }],
      // One idiom is sound and still reported: keep the assertion promise,
      // advance fake timers, then await it. Mark it with eslint-disable-next-line
      // and the reason; the rule's autofix would await it on the spot and hang the test.
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
      // The whole list again: a later block replaces a rule's options.
      'no-restricted-syntax': ['error', NO_MD5, NO_NAKED_SDK_CLIENT],
    },
  },

  {
    files: ['src/handlers/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: ['aws-cdk-lib', 'constructs', 'cdk-nag'].map((name) => ({ name, message: NO_CDK_IN_HANDLERS })),
        patterns: [{ group: ['aws-cdk-lib/*', '@aws-cdk/*'], message: NO_CDK_IN_HANDLERS }],
      }],
      'import-x/no-restricted-paths': ['error', {
        basePath: __dirname,
        zones: [{
          target: './src/handlers',
          from: './src',
          except: HANDLER_IMPORT_ALLOW_LIST,
          message: NO_CDK_IN_HANDLERS,
        }],
      }],
    },
  },

  {
    files: ['src/handlers/shared/repo-config.ts'],
    rules: {
      'preserve-caught-error': 'off',
    },
  },

  {
    files: ['test/**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-magic-numbers': 'off',
      '@stylistic/max-len': 'off',
    },
  },

  {
    files: ['scripts/**/*.{ts,tsx,mts,cts}'],
    rules: {
      'no-console': 'off',
    },
  },
];
