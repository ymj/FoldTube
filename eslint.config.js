import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: ['dist/', 'docs/', 'node_modules/', '.claude/'],
  },
  js.configs.recommended,
  {
    // Extension code that runs as ES modules (service worker, scraper).
    files: ['background/**/*.js', 'content/**/*.js', 'lib/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker, ...globals.webextensions },
    },
  },
  {
    // Dashboard: dashboard.js is a module; theme-init.js is a classic script.
    files: ['dashboard/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions },
    },
  },
  {
    files: ['dashboard/theme-init.js'],
    languageOptions: { sourceType: 'script' },
  },
  {
    // Tooling and tests run in Node.
    files: ['eslint.config.js', 'test/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none', argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
