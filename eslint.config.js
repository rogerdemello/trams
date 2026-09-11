import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint rules chosen to catch the mistakes that actually matter in this codebase
 * rather than to enforce style — formatting is Prettier's job.
 *
 * The rules that earn their place here are the async ones. In a system built on
 * a message broker and a transactional outbox, a forgotten `await` does not
 * throw; it silently returns a pending promise, the transaction commits without
 * the outbox row, and an event vanishes. `no-floating-promises` and
 * `no-misused-promises` catch exactly that class of bug at build time.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'coverage/**',
      '.probe/**',
      'infra/nats/jetstream/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Root-level tool configs sit outside every tsconfig's `include`
          // (the root tsconfig is solution-style with `files: []`), so the
          // project service needs them named explicitly.
          allowDefaultProject: ['vitest.config.ts', 'eslint.config.js', 'infra/scripts/*.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── The async correctness rules — the reason this config exists ────────
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],

      // Off, and deliberately so. Several interfaces in this codebase REQUIRE
      // an async signature regardless of whether a given implementation
      // awaits anything: Fastify's `FastifyPluginAsync`, the `DependencyCheck`
      // readiness probe, and `NotificationChannel.verify()`. An implementation
      // that happens to be synchronous is satisfying a contract, not making a
      // mistake, so this rule produces only false positives here.
      '@typescript-eslint/require-await': 'off',

      // ── Type-safety rules kept strict ────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'off', // noisy with env-derived config
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // Non-null assertions are used deliberately after a route guard has
      // populated `request.authenticatedUser`. Warn rather than error so they
      // stay visible without blocking the build.
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Template literals with a non-string are usually a logging mistake, but
      // numbers and booleans are legitimate and pervasive here.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],

      // ── General correctness ──────────────────────────────────────────────
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  {
    // Scripts and the smoke test exist to print to a terminal; console is the
    // whole point, and they are not part of the compiled service projects.
    files: [
      'infra/scripts/**/*.{ts,mjs,js}',
      'tests/smoke/**/*.ts',
      'tests/helpers/**/*.ts',
      'eslint.config.js',
      'vitest.config.ts',
    ],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },

  {
    // Tests assert on parsed JSON, which is `any` by nature. Enforcing full
    // type-safety on assertions adds ceremony without catching real defects.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },

  {
    // Plain-JS infra scripts are not covered by a tsconfig project, so the
    // type-aware rules cannot run on them. They also need Node's globals
    // declared explicitly — without this, `process` and `console` read as
    // undefined variables.
    files: ['**/*.{js,mjs}'],
    // The spread comes FIRST: `disableTypeChecked` carries its own
    // `languageOptions`, so spreading it after would replace the globals below
    // wholesale and `process`/`console` would read as undefined again.
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      globals: globals.node,
    },
  },
);
