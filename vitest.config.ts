import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The property-based and resource-abuse suites deliberately run hundreds
    // of generated cases over megabyte-scale inputs. They finish in a couple
    // of seconds normally, but v8 coverage instrumentation slows the engine
    // down by roughly an order of magnitude, and CI runners are slower again,
    // so the 5 s default would fail on timing rather than on behaviour.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        // The bin entry point is process wiring only — argv, stdin, stdout and
        // `process.exitCode` — around `run()`, which test/cli/run.test.ts
        // covers directly through an injected `CliIo`. Its own behaviour is
        // verified end to end by test/cli/e2e.test.ts, which spawns the built
        // binary as a child process, and a child process is invisible to the
        // in-process coverage instrumentation.
        'src/cli/index.ts',
      ],
      thresholds: {
        lines: 95,
        statements: 95,
        functions: 95,
        branches: 90,
      },
    },
  },
});
