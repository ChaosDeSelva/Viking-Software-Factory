import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

// Lints the dashboard (JSX) and the shared contract it imports. The API and tests keep their own
// dense style and are covered by `npm test`.
export default [
  { ignores: ['dist/**', 'node_modules/**', 'vendor/**'] },
  {
    files: ['apps/web/src/**/*.{js,jsx}', 'packages/contracts/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // JSX element usage is not seen by core no-unused-vars; React itself is the only false positive.
      'no-unused-vars': ['error', { varsIgnorePattern: '^React$' }],
    },
  },
];
