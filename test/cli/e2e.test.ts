import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * End-to-end coverage that spawns the real, built `dist/cli.js` binary as a
 * child process, proving that the bundle produced by `tsup` actually works
 * outside of the in-memory `CliIo` harness used by `test/cli/run.test.ts`.
 *
 * These tests read `dist/`, they do not produce it: `npm run verify` and the
 * CI workflow both build before running the suite, so the binary under test
 * is always current. On a tree that has never been built, `npm test` alone
 * skips this file rather than failing, since a missing build directory is a
 * missing prerequisite rather than a defect in the package.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(ROOT, 'dist', 'cli.js');
const BUILT = existsSync(CLI_PATH);

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  stdin?: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    // Never spawn through a shell: `process.execPath` routinely contains
    // spaces (for example `C:\Program Files\nodejs\node.exe`), and a shell
    // with unescaped arguments would split that path apart instead of
    // running it.
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process '${command} ${args.join(' ')}' timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // A non-zero exit is data, not an error: the CLI's exit codes are part of
    // what these tests assert. Only a failure to spawn at all rejects.
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

describe('the real dist/cli.js binary', () => {
  it('repairs malformed JSON piped on stdin and exits 0', async (ctx) => {
    if (!BUILT) {
      ctx.skip();
      return;
    }

    const result = await runProcess(process.execPath, [CLI_PATH], ROOT, 10_000, '{a:1,}');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('{"a":1}\n');
    expect(result.stderr).toBe('');
  });

  it('reports a JsonRepairError on stderr and exits 1 for unrepairable input', async (ctx) => {
    if (!BUILT) {
      ctx.skip();
      return;
    }

    const result = await runProcess(
      process.execPath,
      [CLI_PATH],
      ROOT,
      10_000,
      '{"a": "he said "hi", ok"}',
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('AMBIGUOUS_REPAIR');
  });
});
