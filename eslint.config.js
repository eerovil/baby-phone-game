import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['node_modules/**', 'public/app.js', '.wrangler/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Build scripts and the service worker are plain JavaScript run outside the
    // TypeScript project, with their own globals.
    files: ['scripts/*.mjs', 'dev/*.mjs', 'public/sw.js'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        caches: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        process: 'readonly',
        self: 'readonly',
        setTimeout: 'readonly',
        URL: 'readonly',
        WebSocket: 'readonly',
      },
    },
  },
];
