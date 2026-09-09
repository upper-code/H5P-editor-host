import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// The shared relaxations. They exist because this codebase leans on caught
// errors it deliberately ignores and on catch-all guards, not because the
// rules are wrong.
const shared = {
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-constant-condition': ['warn', { checkLoops: false }],
  'no-control-regex': 'off',
  'no-useless-escape': 'warn',
  'no-console': 'off',
  'prefer-const': 'warn'
};

export default tseslint.config(
  {
    // `assets/` and `sources/` are vendored third-party code, kept byte for
    // byte as it was published.
    ignores: [
      'build/',
      'node_modules/',
      'assets/',
      'sources/',
      '.host-data/'
    ]
  },
  js.configs.recommended,
  // The TypeScript presets apply to the TypeScript only: applied to plain
  // JavaScript they object to `require` and to Node's own idioms.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['src/**/*.ts']
  })),
  prettier,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 }
    },
    rules: {
      ...shared,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-this-alias': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }
      ]
    }
  },
  // The editor bridge runs in the browser with no build step, and it is the
  // one place where a stale name or a missing `await` reaches a user with no
  // compiler in between.
  {
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: { ...shared, 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  },
  {
    files: ['test/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.es2022 }
    },
    rules: { ...shared, 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2022 }
    },
    rules: { ...shared, 'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }] }
  }
);
