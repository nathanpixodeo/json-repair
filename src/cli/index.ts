#!/usr/bin/env node

/**
 * Executable entry point for the `json-repair` command.
 *
 * Everything that talks to the operating system lives here and nowhere else
 * in `src/`: the library bundle is checked to contain no Node built-ins so it
 * stays usable in browsers and other non-Node runtimes, and the CLI is built
 * as a separate bundle specifically so it can depend on them. This file's
 * only job is to wire the real process — `argv`, stdin, stdout, stderr, the
 * exit code — to the host-agnostic {@link run} function, which does the
 * actual work and is what gets unit-tested.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

import { run, type CliIo } from './run.js';

/**
 * Reads `process.stdin` to completion as UTF-8 text.
 *
 * Resolves to `undefined` when stdin is a TTY, which is how `run` tells
 * "nothing was piped in" apart from "an empty document was piped in" — an
 * empty pipe still resolves to the empty string, not `undefined`, so that a
 * genuinely empty input reaches the repair engine and fails there with a
 * proper `NO_JSON_FOUND` error instead of being mistaken for "no input at
 * all".
 */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const io: CliIo = {
  readStdin,
  readFile: (path) => readFile(path, 'utf8'),
  write: (text) => {
    process.stdout.write(text);
  },
  writeError: (text) => {
    process.stderr.write(text);
  },
};

/**
 * Runs the CLI and translates its result into `process.exitCode`.
 *
 * Setting `process.exitCode` rather than calling `process.exit()` lets Node
 * finish flushing any pending writes — including stdout when it is piped
 * into another process — before the process actually terminates. Calling
 * `process.exit()` immediately can truncate that output.
 */
async function main(): Promise<void> {
  process.exitCode = await run(process.argv.slice(2), io);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`json-repair: unexpected error: ${message}\n`);
  process.exitCode = 1;
});
