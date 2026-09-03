import { JsonRepairError } from './errors/JsonRepairError.js';
import {
  MAX_SUPPORTED_DEPTH,
  type ExtractOptions,
  type RepairMode,
  type RepairOptions,
} from './types.js';

/** Default maximum input length, in UTF-16 code units. */
export const DEFAULT_MAX_LENGTH = 10_000_000;

/** Default maximum nesting depth. */
export const DEFAULT_MAX_DEPTH = 512;

/**
 * Fully resolved options. Every field is concrete, so the engine never has to
 * re-derive a default or consult the mode for a flag.
 */
export interface ResolvedOptions {
  mode: RepairMode;
  /** Convenience mirror of `mode === 'aggressive'`, read on hot paths. */
  aggressive: boolean;
  extract: boolean;
  allowComments: boolean;
  allowSingleQuotes: boolean;
  allowUnquotedKeys: boolean;
  fixTrailingCommas: boolean;
  fixMissingBrackets: boolean;
  maxLength: number;
  maxDepth: number;
  maxRepairs: number;
  returnMetadata: boolean;
}

/** Which candidate {@link extractJson} returns from a multi-block document. */
export type SelectStrategy = NonNullable<ExtractOptions['select']>;

/**
 * Validates and resolves user options.
 *
 * The boolean flags are tri-state on purpose. `undefined` means "use the
 * default for this mode"; an explicit `true` or `false` always wins, so
 * `{ mode: 'aggressive', allowComments: false }` really does reject comments.
 * All six flags currently default to `true` in both modes — the difference
 * between modes lies in the repairs that have no flag of their own.
 *
 * @throws {JsonRepairError} `INVALID_INPUT` when any option is out of range.
 */
export function resolveOptions(options: RepairOptions | undefined): ResolvedOptions {
  const source = asOptionBag(options);
  const mode = resolveMode(source.mode);

  return {
    mode,
    aggressive: mode === 'aggressive',
    extract: resolveFlag(source.extract, 'extract', true),
    allowComments: resolveFlag(source.allowComments, 'allowComments', true),
    allowSingleQuotes: resolveFlag(source.allowSingleQuotes, 'allowSingleQuotes', true),
    allowUnquotedKeys: resolveFlag(source.allowUnquotedKeys, 'allowUnquotedKeys', true),
    fixTrailingCommas: resolveFlag(source.fixTrailingCommas, 'fixTrailingCommas', true),
    fixMissingBrackets: resolveFlag(source.fixMissingBrackets, 'fixMissingBrackets', true),
    maxLength: resolveLimit(source.maxLength, 'maxLength', DEFAULT_MAX_LENGTH, 1, Infinity),
    maxDepth: resolveLimit(source.maxDepth, 'maxDepth', DEFAULT_MAX_DEPTH, 1, MAX_SUPPORTED_DEPTH),
    maxRepairs: resolveLimit(source.maxRepairs, 'maxRepairs', Infinity, 0, Infinity),
    returnMetadata: resolveFlag(source.returnMetadata, 'returnMetadata', false),
  };
}

/**
 * Views the caller's options as a bag of unknown values.
 *
 * Every field is then validated as `unknown` rather than as its declared type,
 * because the declared type is only a promise: JavaScript callers, and
 * TypeScript callers who have cast, can pass anything at all. Validating what
 * actually arrived is what turns a mistake into a named `INVALID_INPUT` error
 * instead of undefined behaviour deep in the parser.
 *
 * @throws {JsonRepairError} `INVALID_INPUT`
 */
function asOptionBag(options: unknown): Record<string, unknown> {
  if (options === undefined) {
    return {};
  }
  if (typeof options !== 'object' || options === null) {
    throw new JsonRepairError(
      'INVALID_INPUT',
      `Options must be an object, received ${describe(options)}.`,
    );
  }
  return options as Record<string, unknown>;
}

/**
 * Resolves options for {@link extractJson} and {@link extractAllJson}.
 *
 * Extraction is the whole point of these entry points, so `extract` is forced
 * on and is not exposed as an option.
 */
export function resolveExtractOptions(
  options: ExtractOptions | undefined,
): ResolvedOptions & { select: SelectStrategy } {
  const source = asOptionBag(options);
  const select = resolveSelect(source.select);

  return { ...resolveOptions({ ...source, extract: true }), select };
}

function resolveSelect(select: unknown): SelectStrategy {
  if (select === undefined) {
    return 'best';
  }
  if (select !== 'best' && select !== 'first' && select !== 'last' && select !== 'largest') {
    throw new JsonRepairError(
      'INVALID_INPUT',
      `Option "select" must be "best", "first", "last" or "largest", received ${describe(select)}.`,
    );
  }
  return select;
}

/** Returns a copy of `options` running in `mode`. */
export function withMode(options: ResolvedOptions, mode: RepairMode): ResolvedOptions {
  return { ...options, mode, aggressive: mode === 'aggressive' };
}

function resolveMode(mode: unknown): RepairMode {
  if (mode === undefined) {
    return 'safe';
  }
  if (mode !== 'safe' && mode !== 'aggressive') {
    throw new JsonRepairError(
      'INVALID_INPUT',
      `Option "mode" must be "safe" or "aggressive", received ${describe(mode)}.`,
    );
  }
  return mode;
}

function resolveFlag(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new JsonRepairError(
      'INVALID_INPUT',
      `Option "${name}" must be a boolean, received ${describe(value)}.`,
    );
  }
  return value;
}

function resolveLimit(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new JsonRepairError(
      'INVALID_INPUT',
      `Option "${name}" must be a number, received ${describe(value)}.`,
    );
  }
  if (value !== Infinity && !Number.isInteger(value)) {
    throw new JsonRepairError(
      'INVALID_INPUT',
      `Option "${name}" must be an integer or Infinity, received ${value}.`,
    );
  }
  if (value < min || value > max) {
    const ceiling = max === Infinity ? 'Infinity' : String(max);
    throw new JsonRepairError(
      'INVALID_INPUT',
      `Option "${name}" must be between ${min} and ${ceiling}, received ${value}.`,
    );
  }
  return value;
}

/** Renders an untrusted value for an error message without ever calling into it. */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'bigint':
      return `${String(value)}n`;
    default:
      return typeof value;
  }
}
