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

const TS_FILES = ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts'];

const NO_MD5 = {
  selector: "CallExpression:matches([callee.name='createHash'], [callee.property.name='createHash']) Literal[value='md5']",
  message: 'Use the md5hash() function from the core library if you want md5',
};
// An AWS SDK client takes one config argument at most; a CDK construct such as
// cognito.UserPoolClient takes (scope, id, props) and is not meant here. The name
// exception is this package's own registry client, which is not an SDK client.
const NO_NAKED_SDK_CLIENT = {
  selector: 'NewExpression[arguments.length<2]:matches('
    + '[callee.name=/^(?!AgentRegistryClient$).*Client$/], [callee.property.name=/Client$/])',
  message: 'Build AWS SDK clients with makeClient(Ctor, cfg) or makeDocClient(cfg) from src/handlers/shared/ua.ts: `new XxxClient()` drops the'
    + ' solution user-agent segment (#319). For a class of this repository whose name merely ends in Client, add the name to'
    + ' the exception in this selector.',
};

// Used by the rules for src/handlers below.
const NO_CDK_IN_HANDLERS = 'Lambda handler code is bundled with everything it imports, and a module that imports the CDK'
  + ' brings the whole library into the function. Inside cdk/src a handler may import only src/handlers and the two'
  + ' import-free modules constructs/task-status and constructs/task-table-indexes. Put a value both sides need in'
  + ' src/handlers/shared (see storage-names.ts) and import it from the construct.';

// What handler code may import from inside cdk/src, relative to src. Add a module only
// if neither it nor anything it imports imports aws-cdk-lib or constructs.
const HANDLER_IMPORT_ALLOW_LIST = ['./handlers', './constructs/task-status.ts', './constructs/task-table-indexes.ts'];
// The handler rules select by path, so a path that no longer exists would switch them
// off without a word: fail the run instead.
for (const allowed of HANDLER_IMPORT_ALLOW_LIST) {
  if (!existsSync(join(__dirname, 'src', allowed))) {
    throw new Error(`cdk/eslint.config.mjs: ${join('src', allowed)} does not exist; update the handler import rules.`);
  }
}

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

  // Correctness baselines: eslint:recommended and the typescript-eslint recommended
  // set. They come before the package block so that block wins where both set a rule.
  { files: TS_FILES, rules: js.configs.recommended.rules },
  ...tseslint.configs['flat/recommended'].map((config) => ({ ...config, files: TS_FILES })),

  // TypeScript source, test, and scripts files
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
      // A holder that a closure reads before its one assignment cannot become a const
      // (the Lazy ARN holders in stacks/agent.ts).
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      // Rules of the recommended sets that still have findings. Each one stays off
      // until its findings are fixed; delete the line to turn the rule on.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
      // Off for good: its one finding is the sanitizer that strips control characters.
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
      // (see contracts/constants.md). Baseline cleaned in #312; blocking like cli/.
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
        devDependencies: ['**/test/**', '**/build-tools/**', '**/scripts/**'],
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
      'jest/no-standalone-expect': 'off',
      'jest/valid-expect': 'off',
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
      // Jest has no `fail()`: the call is a ReferenceError, which the catch block of
      // a try/fail/catch test swallows, so the test passes when nothing throws.
      'jest/no-jasmine-globals': 'error',
      'jest/no-mocks-import': 'error',
      'jest/no-test-prefixes': 'error',
      'jest/valid-describe-callback': 'error',
      'jest/valid-expect-in-promise': 'error',
    },
  },

  // Every AWS SDK client in src is built by the attributed factory (#319).
  {
    files: ['src/**/*.ts'],
    rules: {
      // The whole list again: a later block replaces a rule's options.
      'no-restricted-syntax': ['error', NO_MD5, NO_NAKED_SDK_CLIENT],
    },
  },

  // Lambda runtime code must not reach the CDK. The bundle test
  // (test/handlers/shared/runtime-bundle-boundary.test.ts) bundles every entrypoint and
  // is the ground truth for any import spelling; these two rules name the line.
  {
    files: ['src/handlers/**/*.ts'],
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

  // Override: tests legitimately use inline literals (fixtures, assertions)
  {
    files: ['test/**/*.ts'],
    rules: {
      // Literal fixtures and expected values are the point of a test; naming every
      // one defeats readability.
      '@typescript-eslint/no-magic-numbers': 'off',
      // Table-driven assertions and long expected strings read better on one line
      // than wrapped.
      '@stylistic/max-len': 'off',
      'max-len': 'off',
      // NOTE: `no-shadow` is deliberately NOT relaxed here. It is
      // correctness-adjacent in test code — a shadowed `row` or `mock` inside a
      // nested describe is a common way to assert against the wrong fixture and
      // still pass. Rename the inner binding instead.
    },
  },

  // Override: scripts/ are Node CLI tools invoked by mise (bootstrap generators,
  // preflight checks), not CDK constructs. They print progress and results to
  // the terminal, so console output is their interface.
  {
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
];
