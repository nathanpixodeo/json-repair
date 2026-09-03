// ESLint 9 flat configuration for @nexkit/json-repair.
//
// This project ships a zero-runtime-dependency JSON repair engine, so the
// linting posture here is deliberately strict: the TypeScript rule sets are
// type-aware (they read real type information from the TypeScript compiler,
// not just syntax), and a handful of project-specific rules encode two hard
// invariants of this codebase:
//
//   1. `src/` must never contain a regular expression. The engine's stated
//      security property is that it stays linear-time on hostile input, and
//      regular expressions are the single easiest way to accidentally
//      reintroduce catastrophic backtracking (ReDoS).
//   2. `src/` (outside of `src/cli/**`) must stay platform-neutral. The
//      library core is expected to run unmodified in browsers, Deno, and
//      edge runtimes, so it may not import or reference Node.js built-ins.
//      Only the CLI, which is inherently a Node.js entry point, is exempt.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// `import.meta.dirname` would be shorter, but it only exists from Node 20.11
// onwards and CI lints on Node 18 as well.
const rootDir = dirname(fileURLToPath(import.meta.url));

export default tseslint.config(
  // Never lint build output, coverage reports, or third-party packages.
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },

  // Type-aware linting for every first-party TypeScript source tree: the
  // library core, its tests, the release/CI scripts, the benchmark suite,
  // and the various `*.config.ts` files at the repo root. `extends` here is
  // typescript-eslint's config-composition helper: it scopes each extended
  // config to the `files` glob below, so plain JS/JSON files elsewhere in
  // the repo are unaffected by these TypeScript-only rule sets.
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'scripts/**/*.ts', 'bench/**/*.ts', '*.config.ts'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        // `projectService` lets typescript-eslint resolve the correct
        // tsconfig for each linted file automatically (including files
        // that live outside `src`, such as `bench/bench.mjs`'s TS
        // siblings or `*.config.ts`), rather than pinning a single
        // `project` path.
        projectService: true,
        // Type-aware rules need to resolve tsconfig paths relative to the
        // repo root.
        tsconfigRootDir: rootDir,
      },
    },
    rules: {
      // Interpolating a number into a message is ordinary, safe formatting —
      // every error message in this package reports a position or a limit that
      // way. The rule's real target is objects stringifying to
      // "[object Object]", which stays banned.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      // `parseJson<T>` deliberately mirrors the shape of `JSON.parse`: the type
      // parameter appears once, as an unchecked assertion on the return value.
      // That is the documented, frozen public API, not an oversight.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },

  // --- Library-core-only restrictions (src/**) -----------------------------
  {
    files: ['src/**/*.ts'],
    rules: {
      // `noUncheckedIndexedAccess` is on, so every array index reads as
      // `T | undefined`. The parser indexes arrays it has just bounds-checked,
      // and `non-nullable-type-assertion-style` (also on) actively asks for `!`
      // there rather than a cast, so forbidding `!` outright would leave no way
      // to satisfy both rules.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Ban every form of regular expression in the engine's source. A
      // hand-written character scan is the only construct in this codebase
      // that is guaranteed to stay linear on adversarial input; regular
      // expressions (including the `RegExp` constructor and the bare
      // `RegExp(...)` call form) are the most common way ReDoS creeps back
      // in, so we reject them at the syntax level rather than relying on
      // reviewers to catch it.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[regex]',
          message:
            'Regular expressions are banned in src/: the engine must stay linear on hostile input. Use a character scan instead.',
        },
        {
          selector: "NewExpression[callee.name='RegExp']",
          message:
            'Regular expressions are banned in src/: the engine must stay linear on hostile input. Use a character scan instead.',
        },
        {
          selector: "CallExpression[callee.name='RegExp']",
          message:
            'Regular expressions are banned in src/: the engine must stay linear on hostile input. Use a character scan instead.',
        },
      ],

      // Forbid importing any Node.js built-in module from the library core.
      // The core is documented to run unmodified in browsers, Deno, and
      // edge runtimes, so pulling in `node:fs`, `node:path`, and the like
      // would silently break that promise. `src/cli/**` is the sole
      // exception (see the override block below), since the CLI is
      // necessarily a Node.js-only entry point.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*'],
              message:
                'Node.js built-in imports are banned in src/ (except src/cli/**): the library core must stay browser/Deno/edge compatible.',
            },
          ],
        },
      ],

      // Belt-and-braces companion to the import restriction above: even
      // without an explicit `import`, code can reach for Node-injected
      // globals (`process`, CommonJS's `__dirname`/`__filename`/`require`,
      // or `Buffer`). None of these exist in a browser, Deno, or edge
      // runtime, so referencing them in the core is just as much a
      // portability break as importing `node:*` directly.
      'no-restricted-globals': [
        'error',
        {
          name: 'process',
          message:
            '`process` is a Node.js global with no browser/Deno/edge equivalent; keep the library core runtime-neutral.',
        },
        {
          name: '__dirname',
          message:
            '`__dirname` only exists under CommonJS/Node.js; keep the library core runtime-neutral.',
        },
        {
          name: '__filename',
          message:
            '`__filename` only exists under CommonJS/Node.js; keep the library core runtime-neutral.',
        },
        {
          name: 'require',
          message:
            '`require` is a CommonJS/Node.js global; use static ES module imports, and do not reach for Node built-ins in the core.',
        },
        {
          name: 'Buffer',
          message:
            '`Buffer` is a Node.js global with no browser equivalent; keep byte handling out of the library core.',
        },
      ],
    },
  },

  // The CLI is an explicitly Node.js-only entry point (see tsup.config.ts,
  // which builds it with `platform: 'node'`), so it is the one part of
  // `src/` that is allowed to use Node built-ins and Node globals.
  {
    files: ['src/cli/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-globals': 'off',
    },
  },

  // --- Test-only relaxations (test/**) --------------------------------------
  {
    files: ['test/**/*.ts'],
    rules: {
      // Tests frequently assert on values that are known-non-null only by
      // virtue of the test setup (e.g. `result.value!`), which the compiler
      // cannot prove. Forcing verbose narrowing in test code buys nothing.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Tests routinely construct malformed/`any`-typed fixtures on purpose
      // (that is the point of a JSON-repair test suite) and inspect
      // parser/JSON.parse output whose type is not statically known. The
      // `no-unsafe-*` family would otherwise flag nearly every fixture.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Non-breaking spaces, ideographic spaces and byte order marks are
      // fixtures here, not accidents: the whole point of `test/unicode/` is to
      // pin down how the engine treats them.
      'no-irregular-whitespace': 'off',
    },
  },
);
