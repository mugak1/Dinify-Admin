// @ts-check
//
// ESLint 9 FLAT CONFIG — a deliberate divergence from Dinify-Frontend, which is still
// on ESLint 8 + `.eslintrc.json`. ESLint 8.57.1 is end-of-life and npm says so on every
// install; carrying an unsupported linter into the CONTROL-PLANE repo is a posture cost
// that only grows. Architecture stays in lockstep with the sibling (Angular major,
// zone-based change detection, standalone components, signals) because a developer reads
// component code across both repos daily; nobody reads a lint config while writing a
// component, so the build tooling does not have to match.
//
// THE RULE SET IS MIRRORED even though the file format is not — the constraints on code
// are the same as the sibling's. Two rules the sibling switches OFF are left ON here, and
// both omissions are principled rather than accidental:
//
//   @angular-eslint/prefer-standalone — the sibling disables it because it still has
//     seven NgModules. This repo has ZERO and never will, so the rule enforces a stated
//     invariant rather than nagging about legacy.
//   @angular-eslint/prefer-inject — the sibling disables it because most of its
//     components use constructor DI. Everything here uses inject(), so the rule pins
//     what the code already does.
//
// This repo is the reference for the sibling's eventual flat-config migration.
const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const angular = require('angular-eslint');

module.exports = tseslint.config(
  {
    // Not source. `dist` and `coverage` are build output; `.angular` is the CLI cache.
    ignores: ['dist/**', 'coverage/**', 'out-tsc/**', '.angular/**', 'node_modules/**'],
  },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      // Mirrors the sibling's .eslintrc.json rule-for-rule.
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'app', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'app', style: 'kebab-case' },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-alert': 'warn',
    },
  },
  {
    // Node scripts and config files are CommonJS and run outside the browser.
    files: ['*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { require: 'readonly', module: 'writable', __dirname: 'readonly',
                 process: 'readonly', console: 'readonly' },
    },
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.html'],
    extends: [
      ...angular.configs.templateRecommended,
      ...angular.configs.templateAccessibility,
    ],
    rules: {},
  },
);
