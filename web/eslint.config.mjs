import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import licenseHeader from 'eslint-plugin-license-header';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig(
  { ignores: ['dist/', 'coverage/', 'node_modules/', '**/*.js'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'],
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.{ts,tsx}'],
    // Type information for the type-aware rules below, from web/tsconfig.json.
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: __dirname } },
    plugins: { 'license-header': licenseHeader },
    rules: {
      'license-header/header': ['error', join(__dirname, 'header.js')],
      'eqeqeq': ['error', 'always'],
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
);
