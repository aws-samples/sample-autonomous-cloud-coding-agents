import cdklabsPlugin from '@cdklabs/eslint-plugin';
import stylisticPlugin from '@stylistic/eslint-plugin';
import typescriptPlugin from '@typescript-eslint/eslint-plugin';
import typescriptParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import jestPlugin from 'eslint-plugin-jest';
import jsdocPlugin from 'eslint-plugin-jsdoc';
import licenseHeaderPlugin from 'eslint-plugin-license-header';

export default [
  // Global ignores (replaces ignorePatterns)
  {
    ignores: ['**/*.js', '**/*.d.ts', 'node_modules/', '**/*.generated.ts', 'coverage/'],
  },

  // TypeScript config for all .ts/.tsx files
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'test/**/*.ts', 'test/**/*.tsx'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2018,
        sourceType: 'module',
        project: './tsconfig.dev.json',
      },
    },
    plugins: {
      '@typescript-eslint': typescriptPlugin,
      'import': importPlugin,
      '@stylistic': stylisticPlugin,
      '@cdklabs': cdklabsPlugin,
      'license-header': licenseHeaderPlugin,
      'jsdoc': jsdocPlugin,
      'jest': jestPlugin,
    },
    settings: {
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import/resolver': {
        node: {},
        typescript: {
          project: './tsconfig.dev.json',
          alwaysTryTypes: true,
        },
      },
    },
    rules: {
      // --- @stylistic rules ---
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

      // --- Core ESLint rules ---
      'curly': ['error', 'multi-line', 'consistent'],
      'dot-notation': ['error'],
      'no-bitwise': ['error'],
      'no-throw-literal': ['error'],
      'eol-last': ['error', 'always'],
      'no-console': ['error'],
      'no-duplicate-imports': ['error'],
      'no-restricted-syntax': ['error', {
        selector: "CallExpression:matches([callee.name='createHash'], [callee.property.name='createHash']) Literal[value='md5']",
        message: 'Use the md5hash() function from the core library if you want md5',
      }],

      // --- @typescript-eslint rules ---
      '@typescript-eslint/no-require-imports': 'error',
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',
      '@typescript-eslint/no-floating-promises': ['error'],
      'no-return-await': 'off',
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

      // --- import rules ---
      'import/no-extraneous-dependencies': ['error', {
        devDependencies: ['**/test/**', '**/build-tools/**'],
        optionalDependencies: false,
        peerDependencies: true,
      }],
      'import/no-unresolved': ['error'],
      'import/order': ['error', {
        groups: ['builtin', 'external'],
        alphabetize: { order: 'asc', caseInsensitive: true },
      }],
      'import/no-duplicates': ['error'],

      // --- @cdklabs rules ---
      '@cdklabs/no-core-construct': ['error'],
      '@cdklabs/invalid-cfn-imports': ['error'],
      '@cdklabs/no-literal-partition': ['error'],
      '@cdklabs/no-invalid-path': ['error'],
      '@cdklabs/promiseall-no-unbounded-parallelism': ['error'],

      // --- license-header ---
      'license-header/header': ['error', 'header.js'],

      // --- jsdoc rules ---
      'jsdoc/require-param-description': ['error'],
      'jsdoc/require-property-description': ['error'],
      'jsdoc/require-returns-description': ['error'],
      'jsdoc/check-alignment': ['error'],

      // --- jest rules ---
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
