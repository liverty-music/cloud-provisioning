import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '*.d.ts',
      'eslint.config.mjs',
    ],
  },

  // Apply recommended configs for ESLint and TypeScript-ESLint
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Custom rules for TypeScript files
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'prefer-const': 'error',
      '@typescript-eslint/no-var-requires': 'error',
    },
  },

  // Custom rules for JavaScript files
  {
    files: ['**/*.js'],
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'prefer-const': 'error',
    },
  },

  // Prettier config. This must be the last item.
  // This allows it to override formatting rules from other configs.
  eslintPluginPrettierRecommended,
);
