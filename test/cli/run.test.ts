import { describe, expect, it } from 'vitest';

import { run, type CliIo } from '../../src/cli/run.js';

/**
 * Coverage for the CLI's argument parsing and orchestration logic, driven
 * directly through `run` with an in-memory `CliIo` — no subprocess is
 * spawned here, so every assertion below can inspect exactly what the CLI
 * would have written without any of the timing or platform variance that
 * comes with spawning a real process. `test/cli/e2e.test.ts` covers the
 * real binary end to end.
 */

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;

/** A `CliIo` that records everything written to it, backed by in-memory stdin and files. */
function createIo(input: {
  stdin?: string | undefined;
  files?: Record<string, string>;
}): CliIo & { stdout: string; stderr: string } {
  const io = {
    stdout: '',
    stderr: '',
    readStdin: (): Promise<string | undefined> => Promise.resolve(input.stdin),
    readFile: (path: string): Promise<string> => {
      const files = input.files ?? {};
      if (Object.prototype.hasOwnProperty.call(files, path)) {
        return Promise.resolve(files[path]!);
      }
      return Promise.reject(new Error(`ENOENT: no such file or directory, open '${path}'`));
    },
    write: (text: string): void => {
      io.stdout += text;
    },
    writeError: (text: string): void => {
      io.stderr += text;
    },
  };
  return io;
}

describe('--help / -h', () => {
  it('prints usage and exits successfully, for both the long and short form', async () => {
    for (const flag of ['--help', '-h']) {
      const io = createIo({});
      const code = await run([flag], io);
      expect(code).toBe(EXIT_SUCCESS);
      expect(io.stdout).toContain('Usage: json-repair');
      expect(io.stdout).toContain('--pretty');
      expect(io.stderr).toBe('');
    }
  });
});

describe('--version / -v', () => {
  it('prints the version and exits successfully, for both the long and short form', async () => {
    for (const flag of ['--version', '-v']) {
      const io = createIo({});
      const code = await run([flag], io);
      expect(code).toBe(EXIT_SUCCESS);
      expect(io.stdout).toBe('1.0.0\n');
      expect(io.stderr).toBe('');
    }
  });
});

describe('input resolution', () => {
  it('reads from stdin when no file is given', async () => {
    const io = createIo({ stdin: '{"a":1}' });
    const code = await run([], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{"a":1}\n');
  });

  it('reads from the named file when one is given', async () => {
    const io = createIo({ files: { 'input.json': '{"a":1}' } });
    const code = await run(['input.json'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{"a":1}\n');
  });

  it('reports a usage error, with exit code 2, when the named file does not exist', async () => {
    const io = createIo({ files: {} });
    const code = await run(['missing.json'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr).toContain("cannot read file 'missing.json'");
    expect(io.stderr).toContain("Try 'json-repair --help'");
  });

  it('prefers the file over stdin when both are available', async () => {
    const io = createIo({
      stdin: '{"fromStdin":true}',
      files: { 'input.json': '{"fromFile":true}' },
    });
    const code = await run(['input.json'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{"fromFile":true}\n');
  });

  it('reports a usage error, with exit code 2, when there is no file and stdin is a TTY (undefined)', async () => {
    const io = createIo({ stdin: undefined });
    const code = await run([], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr).toContain('no input file given and no input piped on stdin');
  });
});

describe('--pretty and --indent', () => {
  it('pretty-prints with the default indent of 2 when --pretty is given alone', async () => {
    const io = createIo({ stdin: '{"a":1,"b":2}' });
    const code = await run(['--pretty'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe(`${JSON.stringify({ a: 1, b: 2 }, null, 2)}\n`);
  });

  it('accepts --indent 0, producing the same single-line output as no indentation', async () => {
    const io = createIo({ stdin: '{"a":1,"b":2}' });
    const code = await run(['--pretty', '--indent', '0'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe(`${JSON.stringify({ a: 1, b: 2 }, null, 0)}\n`);
  });

  it('accepts --indent 4', async () => {
    const io = createIo({ stdin: '{"a":1,"b":2}' });
    const code = await run(['--pretty', '--indent', '4'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe(`${JSON.stringify({ a: 1, b: 2 }, null, 4)}\n`);
  });

  it('rejects --indent 11, which is above the maximum of 10', async () => {
    const io = createIo({ stdin: '{"a":1}' });
    const code = await run(['--pretty', '--indent', '11'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr).toContain('between 0 and 10');
  });
});

describe('--explain', () => {
  it('writes a repair summary to stderr only, leaving stdout as just the JSON', async () => {
    const io = createIo({ stdin: '{a:1,}' });
    const code = await run(['--explain'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{"a":1}\n');
    expect(io.stderr).toContain('Applied');
    expect(io.stderr).toContain('quoted-key');
    expect(io.stderr).toContain('removed-trailing-comma');
  });

  it('reports "no repairs needed" when the input was already valid JSON', async () => {
    const io = createIo({ stdin: '{"a":1}' });
    const code = await run(['--explain'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{"a":1}\n');
    expect(io.stderr).toBe('No repairs were needed.\n');
  });

  it('writes nothing to stderr when --explain is not given', async () => {
    const io = createIo({ stdin: '{a:1,}' });
    const code = await run([], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stderr).toBe('');
  });
});

describe('--mode', () => {
  // "{"a":NaN}" cannot be repaired in the default safe mode (null would
  // discard a number the author did write) but succeeds in aggressive mode,
  // so it is a fixture where the two modes genuinely disagree.
  const input = '{"a":NaN}';

  it('fails by default (safe mode)', async () => {
    const io = createIo({ stdin: input });
    const code = await run([], io);
    expect(code).toBe(EXIT_FAILURE);
  });

  it('succeeds with "--mode aggressive" (space-separated form)', async () => {
    const io = createIo({ stdin: input });
    const code = await run(['--mode', 'aggressive'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{"a":null}\n');
  });

  it('succeeds with "--mode=aggressive" (inline form)', async () => {
    const io = createIo({ stdin: input });
    const code = await run(['--mode=aggressive'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{"a":null}\n');
  });

  it('rejects an unknown mode value, with exit code 2', async () => {
    const io = createIo({ stdin: input });
    const code = await run(['--mode', 'bogus'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr).toContain("'safe' or 'aggressive'");
  });
});

describe('--no-* flags disable their repair even in aggressive mode', () => {
  it('--no-comments leaves a comment as unrecognised, mangled content instead of stripping it', async () => {
    const io = createIo({ stdin: '{ "a": 1 /* c */ }' });
    const code = await run(['--mode', 'aggressive', '--no-comments'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).not.toBe('{"a":1}\n');
  });

  it('--no-single-quotes fails on a single-quoted object, exit code 1', async () => {
    const io = createIo({ stdin: "{'a':1}" });
    const code = await run(['--mode', 'aggressive', '--no-single-quotes'], io);
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stderr).toContain('UNREPAIRABLE_JSON');
  });

  it('--no-unquoted-keys drops the unrecognised bare key', async () => {
    const io = createIo({ stdin: '{a:1}' });
    const code = await run(['--mode', 'aggressive', '--no-unquoted-keys'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{}\n');
  });

  it('--no-trailing-commas fails on a trailing comma, exit code 1', async () => {
    const io = createIo({ stdin: '{"a":1,}' });
    const code = await run(['--mode', 'aggressive', '--no-trailing-commas'], io);
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stderr).toContain('UNREPAIRABLE_JSON');
  });

  it('--no-missing-brackets fails on an unterminated object, exit code 1', async () => {
    const io = createIo({ stdin: '{"a":1' });
    const code = await run(['--mode', 'aggressive', '--no-missing-brackets'], io);
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stderr).toContain('UNREPAIRABLE_JSON');
  });

  it('--no-extract disables isolating JSON from surrounding prose', async () => {
    const io = createIo({ stdin: 'Here: {"a":1} done.' });
    const code = await run(['--mode', 'aggressive', '--no-extract'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).not.toBe('{"a":1}\n');
  });
});

describe('numeric flags reject non-non-negative-integer values', () => {
  const numericFlags = ['--max-length', '--max-depth', '--max-repairs'];
  const badValues = ['abc', '-1', '1.5'];

  for (const flag of numericFlags) {
    for (const bad of badValues) {
      it(`${flag} rejects "${bad}"`, async () => {
        const io = createIo({ stdin: '{"a":1}' });
        const code = await run([flag, bad], io);
        expect(code).toBe(EXIT_USAGE);
        expect(io.stderr).toContain('non-negative integer');
      });
    }
  }
});

describe('clustered short flags', () => {
  it('-pe applies both --pretty and --explain', async () => {
    const io = createIo({ stdin: '{a:1,}' });
    const code = await run(['-pe'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\n`);
    expect(io.stderr).toContain('Applied');
  });

  it('-m must be the last flag in a cluster', async () => {
    const io = createIo({ stdin: '{"a":NaN}' });
    const code = await run(['-mp', 'aggressive'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr).toContain("'-m' must be the last flag");
  });

  it('-pm aggressive works because -m is last', async () => {
    const io = createIo({ stdin: '{"a":NaN}' });
    const code = await run(['-pm', 'aggressive'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe(`${JSON.stringify({ a: null }, null, 2)}\n`);
  });
});

describe('-- terminates flag parsing', () => {
  it('lets a file literally named "-p" be read as a positional argument', async () => {
    const io = createIo({ files: { '-p': '{"a":1}' } });
    const code = await run(['--', '-p'], io);
    expect(code).toBe(EXIT_SUCCESS);
    expect(io.stdout).toBe('{"a":1}\n');
  });
});

describe('malformed command lines', () => {
  it('rejects an unknown long flag, exit code 2', async () => {
    const io = createIo({ stdin: '{"a":1}' });
    const code = await run(['--bogus'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr).toContain("unknown option '--bogus'");
  });

  it('rejects a second positional argument, exit code 2', async () => {
    const io = createIo({ files: { 'a.json': '{"a":1}', 'b.json': '{"b":2}' } });
    const code = await run(['a.json', 'b.json'], io);
    expect(code).toBe(EXIT_USAGE);
    expect(io.stderr).toContain("unexpected argument 'b.json'");
  });
});

describe('unrepairable input', () => {
  it('exits with code 1 and writes the JsonRepairError code, message and location to stderr', async () => {
    const io = createIo({ stdin: '{"a": "he said "hi", ok"}' });
    const code = await run([], io);
    expect(code).toBe(EXIT_FAILURE);
    expect(io.stdout).toBe('');
    expect(io.stderr).toContain('json-repair: AMBIGUOUS_REPAIR:');
    expect(io.stderr).toMatch(/at line \d+, column \d+:/);
  });
});

describe('stdout newline invariant', () => {
  it('always ends with exactly one trailing newline on success', async () => {
    const fixtures = ['{"a":1}', '{a:1,}', '[1,2,3]'];
    for (const stdin of fixtures) {
      const io = createIo({ stdin });
      const code = await run([], io);
      expect(code).toBe(EXIT_SUCCESS);
      expect(io.stdout.endsWith('\n')).toBe(true);
      expect(io.stdout.endsWith('\n\n')).toBe(false);
    }
  });
});
