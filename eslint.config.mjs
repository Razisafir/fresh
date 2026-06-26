/**
 * eslint.config.mjs — Kovix ESLint flat config.
 *
 * Pragmatic, not maximalist. Goal: mechanical backstop for the security
 * + dead-code claims in docs/ISSUES.md "Quality Pass Results" section,
 * WITHOUT enforcing a style opinion that would generate 200 reformat-only
 * changes on an already-shipped codebase.
 *
 * What this config enforces:
 *   - `@eslint/js` recommended — catches real bugs (undeclared vars,
 *     unreachable code, comparing with ==, etc.)
 *   - `typescript-eslint` recommended — catches TS-specific footguns
 *     (unused vars, any-typed args, non-null assertions where avoidable)
 *   - `no-eval` + `no-new-func` — security invariant (no dynamic code
 *     execution). Backs up the claim in ISSUES.md "Dead Code / Unused
 *     Exports — PASS".
 *   - `no-restricted-imports` + `no-restricted-syntax` for
 *     `child_process.exec` and `child_process.execSync` — security
 *     invariant (SEC-3, SEC-7). The agent must use `spawn()` /
 *     `spawnSync()` because they don't invoke a shell. This rule will
 *     fire on ANY future reintroduction of exec/execSync.
 *   - `@typescript-eslint/no-unused-vars` — backs up the "no dead code"
 *     claim. Pattern `^_` is allowed for intentionally-unused args
 *     (e.g. `_event` parameters in callback signatures).
 *
 * What this config does NOT enforce:
 *   - Indentation, line length, semicolon preferences
 *   - Import ordering
 *   - Naming conventions
 *   - JSDoc presence (already covered manually per ISSUES.md)
 *   - Type-aware rules (would require projectService; deferred until
 *     we have a real reason — recommended rules are sufficient for
 *     this gate-check)
 *
 * Globals:
 *   - Node files get `globals.node`
 *   - Test files additionally get `globals.mocha`
 *   - Webview client JS (`src/ui/webview/*.js`) gets `globals.browser`
 *     plus `acquireVsCodeApi` (the VS Code webview API global)
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  // ----------------------------------------------------------------
  // Ignores — applied first, before any rule config
  // ----------------------------------------------------------------
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.d.ts',
      '.vscode-test/**',
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
      // Security invariants — back up the ISSUES.md claims mechanically
      'no-eval': 'error',
      'no-new-func': 'error',
      // Unused vars — JS files use the base rule; TS files override below.
      // Allow `_`-prefixed names for intentionally-unused args/callbacks.
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
  // TypeScript files — recommended TS rules + unused-vars tightening
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
      // Disable the base rule in favour of the TS-aware version
      'no-unused-vars': 'off',
    },
  },

  // ----------------------------------------------------------------
  // Test files — mocha + chai globals
  // ----------------------------------------------------------------
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.mocha,
      },
    },
    rules: {
      // Test setup often uses `any` for vscode stubs; not a security concern
      // in test code.
      '@typescript-eslint/no-explicit-any': 'off',
      // Chai assertions like `expect(x).to.be.true;` trigger false positives
      // — they ARE the test, they just look like unused member expressions.
      // Standard workaround (alternative is eslint-plugin-chai-friendly,
      // which adds a dependency for a single-rule issue).
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },

  // ----------------------------------------------------------------
  // Webview client JS — runs inside the webview iframe (browser env),
  // plus the VS Code `acquireVsCodeApi()` global.
  // ----------------------------------------------------------------
  {
    files: ['src/ui/webview/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        acquireVsCodeApi: 'readonly',
      },
    },
  },
);
