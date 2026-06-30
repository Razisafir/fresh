/**
 * eslint.config.mjs — Kovix ESLint flat config.
 *
 * Phase 0 pivot (D-015): Updated for Electron standalone app.
 *   - Renderer JS files get browser globals (no acquireVsCodeApi)
 *   - Source files no longer import from 'vscode'
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // ----------------------------------------------------------------
  // Ignores
  // ----------------------------------------------------------------
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.d.ts',
      '.vscode-test/**',
      'release/**',
      'renderer/monaco/**',  // Vendored Monaco editor files — not our code
    ],
  },

  // ----------------------------------------------------------------
  // Base — all .ts / .js / .mjs / .cjs files
  // ----------------------------------------------------------------
  {
    files: ['**/*.{ts,js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-eval': 'error',
      'no-new-func': 'error',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'child_process',
              importNames: ['exec', 'execSync'],
              message:
                'Use spawn()/spawnSync() instead — exec/execSync invoke a shell and are a shell-injection vector (SEC-3, SEC-7).',
            },
            {
              name: 'vscode',
              message:
                'VS Code API removed in Phase 0 pivot (D-015). Use platform equivalents from src/platform/.',
            },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='child_process'][callee.property.name='exec']",
          message:
            'Use child_process.spawn() — exec invokes a shell (SEC-3, SEC-7).',
        },
        {
          selector:
            "CallExpression[callee.type='MemberExpression'][callee.object.name='child_process'][callee.property.name='execSync']",
          message:
            'Use child_process.spawnSync() — execSync invokes a shell (SEC-3, SEC-7).',
        },
      ],
    },
  },

  // ----------------------------------------------------------------
  // TypeScript files
  // ----------------------------------------------------------------
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'no-unused-vars': 'off',
    },
  },

  // ----------------------------------------------------------------
  // Electron files — allow require() for electron APIs
  // (must come AFTER the TS config so it overrides)
  // ----------------------------------------------------------------
  {
    files: ['electron/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // ----------------------------------------------------------------
  // Test files
  // ----------------------------------------------------------------
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      // Tests may still use the vscode shim
      'no-restricted-imports': 'off',
    },
  },

  // ----------------------------------------------------------------
  // Renderer client JS — runs in the browser context
  // ----------------------------------------------------------------
  {
    files: ['renderer/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-restricted-imports': 'off',
    },
  },
);
