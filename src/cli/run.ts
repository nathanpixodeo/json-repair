/**
 * The `json-repair` command-line interface.
 *
 * This module never touches `process`, `fs` or any other host global — every
 * effect it has on the outside world goes through the {@link CliIo} it is
 * given. That is what makes {@link run} directly unit-testable: a test can
 * hand it in-memory stdin text and capture what it would have written,
 * without spawning a subprocess. `src/cli/index.ts` is the only place that
 * wires this module to the real process.
 */

import {
  isJsonRepairError,
  repairJson,
  type RepairMode,
  type RepairOperation,
  type RepairOptions,
  type RepairResult,
} from '../index.js';

/**
 * The host operations the CLI needs, injected so {@link run} stays free of
 * direct `process` access.
 */
export interface CliIo {
  /** Reads the whole of standard input. Resolves to `undefined` when stdin is a TTY / not piped. */
  readStdin: () => Promise<string | undefined>;
  /** Reads a UTF-8 file. Rejects when the file does not exist. */
  readFile: (path: string) => Promise<string>;
  /** Writes text to standard output. */
  write: (text: string) => void;
  /** Writes text to standard error. */
  writeError: (text: string) => void;
}

/** Process exit code for a successful run. */
const EXIT_SUCCESS = 0;
/** Process exit code for input that could not be repaired. */
const EXIT_FAILURE = 1;
/** Process exit code for a command line the CLI could not make sense of. */
const EXIT_USAGE = 2;

/**
 * The CLI's reported version.
 *
 * This is a literal rather than an import of `package.json`, because pulling
 * JSON into the bundled CLI output would defeat the point of bundling it as a
 * single portable script. It is kept in step with the `version` field in
 * `package.json` by hand, and must be updated alongside it on every release.
 */
const VERSION = '1.0.0';

/** Default `--indent` width in spaces, matching common pretty-printer defaults. */
const DEFAULT_INDENT = 2;

/** Largest `--indent` width the CLI accepts. */
const MAX_INDENT = 10;

/**
 * Usage text shown for `-h`/`--help`. Every line is kept under 80 columns so
 * it reads cleanly in a standard terminal.
 */
const USAGE_TEXT = `Usage: json-repair [options] [file]

Repair malformed JSON from LLM output, logs, or hand-edited config, and
print valid JSON to standard output.

Reads from FILE when one is given, otherwise from standard input.

Options:
  -p, --pretty               Pretty-print the output with indentation
      --indent <n>           Spaces per indent level, used with --pretty
                             (0-10, default: 2)
  -e, --explain              Print a summary of applied repairs to stderr
  -m, --mode <mode>          Repair strategy: "safe" or "aggressive"
                             (default: "safe")
      --no-extract           Do not isolate JSON from surrounding text
      --no-comments          Reject //, /* */ and # comments
      --no-single-quotes     Reject single-quoted strings
      --no-unquoted-keys     Reject unquoted object keys
      --no-trailing-commas   Reject a comma right before } or ]
      --no-missing-brackets  Do not close an unterminated object or array
      --max-length <n>       Maximum accepted input length, in characters
      --max-depth <n>        Maximum accepted nesting depth
      --max-repairs <n>      Maximum number of repairs to apply
  -h, --help                 Show this help message and exit
  -v, --version              Print the version number and exit

Examples:
  json-repair data.json
  json-repair --pretty --explain broken.json > fixed.json
  cat broken.json | json-repair --mode aggressive
`;

/**
 * Runs the CLI end to end: parses `argv`, resolves the input, repairs it and
 * writes the result through `io`.
 *
 * This never throws for a user-facing failure — every error path is turned
 * into a message on `io.writeError` and a numeric exit code, matching the
 * convention that only a genuine defect in this package should surface as an
 * uncaught rejection.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return reportUsageError(io, parsed.message);
  }
  const { args } = parsed;

  if (args.help) {
    io.write(USAGE_TEXT);
    return EXIT_SUCCESS;
  }
  if (args.version) {
    io.write(`${VERSION}\n`);
    return EXIT_SUCCESS;
  }

  const input = await readInput(args.file, io);
  if (!input.ok) {
    return reportUsageError(io, input.message);
  }

  try {
    return repairAndReport(input.text, args, io);
  } catch (error) {
    return reportFailure(io, error);
  }
}

// ---------------------------------------------------------------------------
// Repairing and reporting
// ---------------------------------------------------------------------------

/**
 * Runs the repair, writes the JSON to stdout and, when requested, the
 * explanation to stderr.
 *
 * A `JsonRepairError` thrown by {@link repairJson} is deliberately left to
 * propagate: the caller in {@link run} is the single place that turns it into
 * an exit code, so the failure path is not duplicated here.
 */
function repairAndReport(input: string, args: CliArgs, io: CliIo): number {
  const result = repairJson(input, buildRepairOptions(args));

  const output = args.pretty ? prettyPrint(result.json, args.indent) : result.json;
  io.write(`${output}\n`);

  if (args.explain) {
    io.writeError(formatExplanation(result));
  }

  return EXIT_SUCCESS;
}

/** Builds the options object passed to {@link repairJson}. */
function buildRepairOptions(args: CliArgs): RepairOptions & { returnMetadata: true } {
  return {
    mode: args.mode,
    extract: args.extract,
    allowComments: args.allowComments,
    allowSingleQuotes: args.allowSingleQuotes,
    allowUnquotedKeys: args.allowUnquotedKeys,
    fixTrailingCommas: args.fixTrailingCommas,
    fixMissingBrackets: args.fixMissingBrackets,
    maxLength: args.maxLength,
    maxDepth: args.maxDepth,
    maxRepairs: args.maxRepairs,
    returnMetadata: true,
  };
}

/**
 * Re-renders already-valid JSON text with indentation.
 *
 * `result.json` is guaranteed by {@link repairJson} to be accepted by
 * `JSON.parse`, so the parse here cannot fail on repaired output; it can only
 * fail if the package itself produced invalid JSON, which would be a defect
 * worth surfacing rather than swallowing.
 */
function prettyPrint(json: string, indent: number): string {
  const value: unknown = JSON.parse(json);
  return JSON.stringify(value, null, indent);
}

/**
 * Renders the `--explain` report: a summary line followed by one line per
 * applied repair, or a single "nothing to do" line when the input was
 * already valid JSON.
 */
function formatExplanation(result: RepairResult): string {
  if (!result.changed || result.repairs.length === 0) {
    return 'No repairs were needed.\n';
  }

  const count = result.repairs.length;
  const heading = count === 1 ? 'Applied 1 repair:' : `Applied ${count} repairs:`;

  let text = `${heading}\n`;
  for (const repair of result.repairs) {
    text += `${formatRepairLine(repair)}\n`;
  }
  return text;
}

/**
 * Formats a single repair as `  line:column  type  message`, dropping any
 * segment whose data is unavailable rather than printing a literal
 * "undefined".
 */
function formatRepairLine(repair: RepairOperation): string {
  const segments: string[] = [];

  const location = formatLocation(repair.line, repair.column);
  if (location !== undefined) {
    segments.push(location);
  }
  segments.push(repair.type);
  if (repair.message !== undefined) {
    segments.push(repair.message);
  }

  return `  ${segments.join('  ')}`;
}

/** Renders a line/column pair, tolerating either half being unavailable. */
function formatLocation(line: number | undefined, column: number | undefined): string | undefined {
  if (line !== undefined && column !== undefined) {
    return `${line}:${column}`;
  }
  if (line !== undefined) {
    return `${line}`;
  }
  if (column !== undefined) {
    return `:${column}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Input resolution
// ---------------------------------------------------------------------------

/** Outcome of resolving the CLI's input text, from a file or from stdin. */
type InputResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

/**
 * Reads the text to repair: from the given file when one was named on the
 * command line, otherwise from stdin.
 *
 * A missing file and an unpiped, non-TTY-free stdin are both reported as
 * usage errors rather than exceptions, since both mean the caller did not
 * give the program anything to work with.
 */
async function readInput(file: string | undefined, io: CliIo): Promise<InputResult> {
  if (file !== undefined) {
    try {
      const text = await io.readFile(file);
      return { ok: true, text };
    } catch (error) {
      return { ok: false, message: `cannot read file '${file}': ${errorMessage(error)}` };
    }
  }

  const text = await io.readStdin();
  if (text === undefined) {
    return { ok: false, message: 'no input file given and no input piped on stdin' };
  }
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Error and usage reporting
// ---------------------------------------------------------------------------

/**
 * Reports a `JsonRepairError` from the repair engine, or any other
 * unexpected failure, and returns the exit code that corresponds to it.
 */
function reportFailure(io: CliIo, error: unknown): number {
  if (isJsonRepairError(error)) {
    io.writeError(`json-repair: ${error.code}: ${error.message}\n`);
    if (error.line !== undefined && error.column !== undefined && error.snippet !== undefined) {
      io.writeError(`  at line ${error.line}, column ${error.column}: ${error.snippet}\n`);
    }
    return EXIT_FAILURE;
  }

  io.writeError(`json-repair: unexpected error: ${errorMessage(error)}\n`);
  return EXIT_FAILURE;
}

/** Reports a problem with the command line itself: a bad flag, value or missing input. */
function reportUsageError(io: CliIo, message: string): number {
  io.writeError(`json-repair: ${message}\n`);
  io.writeError(`Try 'json-repair --help' for more information.\n`);
  return EXIT_USAGE;
}

/** Extracts a human-readable message from an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * The command line, fully parsed and validated.
 *
 * Every `RepairOptions` field is left `undefined` when the user did not pass
 * the corresponding flag, so {@link buildRepairOptions} can hand the object
 * straight to {@link repairJson} and let the library apply its own defaults
 * for the selected mode.
 */
interface CliArgs {
  help: boolean;
  version: boolean;
  pretty: boolean;
  indent: number;
  explain: boolean;
  mode: RepairMode | undefined;
  extract: boolean | undefined;
  allowComments: boolean | undefined;
  allowSingleQuotes: boolean | undefined;
  allowUnquotedKeys: boolean | undefined;
  fixTrailingCommas: boolean | undefined;
  fixMissingBrackets: boolean | undefined;
  maxLength: number | undefined;
  maxDepth: number | undefined;
  maxRepairs: number | undefined;
  file: string | undefined;
}

/** {@link CliArgs} minus the resolved positional, built up while scanning `argv`. */
type MutableArgs = Omit<CliArgs, 'file'>;

type ParseArgsResult =
  { readonly ok: true; readonly args: CliArgs } | { readonly ok: false; readonly message: string };

/**
 * Signals that the command line could not be parsed.
 *
 * This is thrown only inside {@link parseArgs} and its helpers and is always
 * caught there — it exists purely to unwind out of deeply nested flag
 * handling without threading a result type through every helper function.
 */
class UsageError extends Error {}

function createDefaultArgs(): MutableArgs {
  return {
    help: false,
    version: false,
    pretty: false,
    indent: DEFAULT_INDENT,
    explain: false,
    mode: undefined,
    extract: undefined,
    allowComments: undefined,
    allowSingleQuotes: undefined,
    allowUnquotedKeys: undefined,
    fixTrailingCommas: undefined,
    fixMissingBrackets: undefined,
    maxLength: undefined,
    maxDepth: undefined,
    maxRepairs: undefined,
  };
}

/**
 * Parses `argv` into {@link CliArgs}.
 *
 * A single left-to-right scan handles long flags (`--flag`, `--flag value`,
 * `--flag=value`), clustered short flags (`-pe`) and the `--` terminator,
 * accumulating at most one positional argument — a second one is reported as
 * a usage error rather than silently discarded, since it almost always means
 * the caller mistyped a flag.
 */
function parseArgs(argv: readonly string[]): ParseArgsResult {
  const args = createDefaultArgs();
  const positionals: string[] = [];
  let flagsEnded = false;
  let index = 0;

  try {
    while (index < argv.length) {
      const token = argv[index];
      if (token === undefined) {
        break;
      }

      if (flagsEnded) {
        positionals.push(token);
        index += 1;
        continue;
      }

      if (token === '--') {
        flagsEnded = true;
        index += 1;
        continue;
      }

      if (token.startsWith('--')) {
        index = applyLongFlag(token, argv, index + 1, args);
        continue;
      }

      if (token.startsWith('-') && token.length > 1) {
        index = applyShortFlags(token, argv, index + 1, args);
        continue;
      }

      positionals.push(token);
      index += 1;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      return { ok: false, message: error.message };
    }
    throw error;
  }

  const [file, extra] = positionals;
  if (extra !== undefined) {
    return { ok: false, message: `unexpected argument '${extra}'` };
  }

  return { ok: true, args: { ...args, file } };
}

/**
 * Applies one long flag, given the index in `argv` immediately after the
 * flag token, and returns the index to resume parsing from.
 *
 * A `--flag=value` token is split on its first `=`, so a value that itself
 * contains `=` still round-trips correctly.
 */
function applyLongFlag(
  token: string,
  argv: readonly string[],
  index: number,
  args: MutableArgs,
): number {
  const separator = token.indexOf('=');
  const name = separator === -1 ? token : token.slice(0, separator);
  const inline = separator === -1 ? undefined : token.slice(separator + 1);

  switch (name) {
    case '--help':
      requireNoInlineValue(name, inline);
      args.help = true;
      return index;
    case '--version':
      requireNoInlineValue(name, inline);
      args.version = true;
      return index;
    case '--pretty':
      requireNoInlineValue(name, inline);
      args.pretty = true;
      return index;
    case '--explain':
      requireNoInlineValue(name, inline);
      args.explain = true;
      return index;
    case '--no-extract':
      requireNoInlineValue(name, inline);
      args.extract = false;
      return index;
    case '--no-comments':
      requireNoInlineValue(name, inline);
      args.allowComments = false;
      return index;
    case '--no-single-quotes':
      requireNoInlineValue(name, inline);
      args.allowSingleQuotes = false;
      return index;
    case '--no-unquoted-keys':
      requireNoInlineValue(name, inline);
      args.allowUnquotedKeys = false;
      return index;
    case '--no-trailing-commas':
      requireNoInlineValue(name, inline);
      args.fixTrailingCommas = false;
      return index;
    case '--no-missing-brackets':
      requireNoInlineValue(name, inline);
      args.fixMissingBrackets = false;
      return index;
    case '--indent': {
      const read = readFlagValue(name, inline, argv, index);
      args.indent = parseIndentValue(name, read.value);
      return read.nextIndex;
    }
    case '--mode': {
      const read = readFlagValue(name, inline, argv, index);
      args.mode = parseModeValue(name, read.value);
      return read.nextIndex;
    }
    case '--max-length': {
      const read = readFlagValue(name, inline, argv, index);
      args.maxLength = parseCountValue(name, read.value);
      return read.nextIndex;
    }
    case '--max-depth': {
      const read = readFlagValue(name, inline, argv, index);
      args.maxDepth = parseCountValue(name, read.value);
      return read.nextIndex;
    }
    case '--max-repairs': {
      const read = readFlagValue(name, inline, argv, index);
      args.maxRepairs = parseCountValue(name, read.value);
      return read.nextIndex;
    }
    default:
      throw new UsageError(`unknown option '${name}'`);
  }
}

/**
 * Applies a run of clustered short flags such as `-pe`, and returns the
 * index to resume parsing from.
 *
 * Only `-m` takes a value; per the CLI's contract it must be the last letter
 * in the cluster, since anything after it would otherwise be ambiguous
 * between "more flags" and "the mode value".
 */
function applyShortFlags(
  token: string,
  argv: readonly string[],
  index: number,
  args: MutableArgs,
): number {
  const body = token.slice(1);
  const separator = body.indexOf('=');
  const cluster = separator === -1 ? body : body.slice(0, separator);
  const inline = separator === -1 ? undefined : body.slice(separator + 1);

  if (inline !== undefined && !cluster.endsWith('m')) {
    throw new UsageError(`option '-${cluster}' does not accept a value`);
  }

  let nextIndex = index;

  for (let position = 0; position < cluster.length; position += 1) {
    const flag = cluster.charAt(position);
    const isLast = position === cluster.length - 1;

    switch (flag) {
      case 'h':
        args.help = true;
        break;
      case 'v':
        args.version = true;
        break;
      case 'p':
        args.pretty = true;
        break;
      case 'e':
        args.explain = true;
        break;
      case 'm': {
        if (!isLast) {
          throw new UsageError(`option '-m' must be the last flag in '-${cluster}'`);
        }
        const read = readFlagValue('-m', inline, argv, nextIndex);
        args.mode = parseModeValue('-m', read.value);
        nextIndex = read.nextIndex;
        break;
      }
      default:
        throw new UsageError(`unknown option '-${flag}'`);
    }
  }

  return nextIndex;
}

/** Rejects a `--flag=value` form for a flag that takes no value. */
function requireNoInlineValue(label: string, inline: string | undefined): void {
  if (inline !== undefined) {
    throw new UsageError(`option '${label}' does not accept a value`);
  }
}

/** The value read for a flag, and the `argv` index parsing should resume from. */
interface FlagValue {
  readonly value: string;
  readonly nextIndex: number;
}

/**
 * Resolves the value for a flag that takes one: the `=`-attached value when
 * there is one, otherwise the next token in `argv`.
 */
function readFlagValue(
  label: string,
  inline: string | undefined,
  argv: readonly string[],
  index: number,
): FlagValue {
  if (inline !== undefined) {
    return { value: inline, nextIndex: index };
  }
  const value = argv[index];
  if (value === undefined) {
    throw new UsageError(`option '${label}' requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

/** Parses a `--mode` value, rejecting anything but the two supported modes. */
function parseModeValue(label: string, raw: string): RepairMode {
  if (raw === 'safe' || raw === 'aggressive') {
    return raw;
  }
  throw new UsageError(`option '${label}' must be 'safe' or 'aggressive', received '${raw}'`);
}

/**
 * Parses a count-like value (`--max-length`, `--max-depth`, `--max-repairs`),
 * rejecting anything that is not a plain non-negative integer.
 *
 * Range limits beyond that (for example `maxDepth` exceeding what the
 * library supports) are intentionally left to `repairJson` itself, which
 * reports them as `INVALID_INPUT` — the CLI only needs to guard against
 * values that are not integers at all.
 */
function parseCountValue(label: string, raw: string): number {
  const value = parseNonNegativeInteger(raw);
  if (value === undefined) {
    throw new UsageError(`option '${label}' must be a non-negative integer, received '${raw}'`);
  }
  return value;
}

/** Parses an `--indent` value, which is CLI-only and has no library-side range check. */
function parseIndentValue(label: string, raw: string): number {
  const value = parseNonNegativeInteger(raw);
  if (value === undefined || value > MAX_INDENT) {
    throw new UsageError(
      `option '${label}' must be an integer between 0 and ${MAX_INDENT}, received '${raw}'`,
    );
  }
  return value;
}

/**
 * Parses a string as a non-negative integer without using a regular
 * expression: every character must be an ASCII digit, and the whole string
 * must be non-empty and within `Number`'s safe integer range.
 */
function parseNonNegativeInteger(raw: string): number | undefined {
  if (raw.length === 0) {
    return undefined;
  }

  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 0x30 || code > 0x39) {
      return undefined;
    }
  }

  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}
