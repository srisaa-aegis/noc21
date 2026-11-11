// @ts-check
/**
 * Lint for the backend and the reusable packages (the Angular app has its own
 * configuration: frontend/eslint.config.js, run with `npm --prefix frontend run lint`).
 */
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig([
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'frontend/**', 'NOC-base/**', 'var/**', '.pgdata/**', 'e2e/**', 'scripts/**'],
  },
  {
    files: ['backend/**/*.ts', 'packages/*/src/**/*.ts', 'packages/*/tests/**/*.ts'],
    extends: [eslint.configs.recommended, tseslint.configs.recommended],
    rules: {
      // Unused parameters kept for a signature are marked with a leading underscore.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      // Services must not reach for process.env directly: configuration goes through config/env.ts.
      'no-restricted-properties': ['error', { object: 'process', property: 'env', message: 'Read settings through config() (backend/src/config/env.ts).' }],
    },
  },
  {
    // Scripts, tests and the configuration module itself read the environment.
    files: ['backend/src/config/**/*.ts', 'backend/scripts/**/*.ts', 'backend/tests/**/*.ts', 'backend/*.config.ts', 'packages/*/tests/**/*.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
]);
