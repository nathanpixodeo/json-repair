/**
 * Public type contracts for `@nexkit/json-repair`.
 *
 * These shapes are frozen for the 1.x line: fields may be added, never removed
 * or narrowed. New {@link RepairType} members may appear in minor releases, so
 * consumers should not write exhaustive `switch` statements over them.
 */

/**
 * How much interpretation the repair engine is allowed to apply.
 *
 * - `safe` (default) applies only repairs with a single plausible reading and
 *   never invents data. Anything ambiguous fails with `AMBIGUOUS_REPAIR`.
 * - `aggressive` additionally applies heuristics that guess intent, such as
 *   quoting bare values or dropping trailing garbage. Aggressive mode always
 *   tries `safe` first, so whenever `safe` succeeds both modes agree byte for
 *   byte.
 */
export type RepairMode = 'safe' | 'aggressive';

/**
 * The kind of change the repair engine made. Every operation reported in
 * {@link RepairResult.repairs} carries one of these.
 *
 * Repairs that discard input have deliberately distinct types
 * (`removed-*`, `terminated-string-at-newline`) so that callers can audit
 * whether any content was lost.
 */
export type RepairType =
  /** A leading U+FEFF byte order mark was removed. */
  | 'removed-byte-order-mark'
  /** JSON was isolated from Markdown fences or surrounding prose. */
  | 'extracted-json'
  /** A `//`, block or `#` comment was removed. */
  | 'removed-comment'
  /** Whitespace JSON does not allow between tokens, such as a non-breaking space, was dropped. */
  | 'normalized-whitespace'
  /** A comma directly before `}` or `]` was removed. */
  | 'removed-trailing-comma'
  /** A repeated or leading comma inside an object was removed. */
  | 'removed-extra-comma'
  /** A closing bracket that matched no open container was discarded. */
  | 'removed-stray-token'
  /** Content after the top-level value was discarded. */
  | 'removed-trailing-content'
  /** A truncated final key or member was discarded (streamed output). */
  | 'removed-incomplete-member'
  /** A missing separator between members or elements was inserted. */
  | 'added-missing-comma'
  /** A missing `:` between a key and its value was inserted. */
  | 'added-missing-colon'
  /** An absent or elided value was replaced by `null`. */
  | 'added-missing-value'
  /** An unclosed object was closed. */
  | 'added-closing-brace'
  /** An unclosed array was closed. */
  | 'added-closing-bracket'
  /** Single, backtick or typographic quotes were converted to `"`. */
  | 'normalized-quotes'
  /** A non-JSON literal was mapped to JSON (`True`, `None`, `NaN`). */
  | 'normalized-literal'
  /** A number literal was rewritten to valid JSON grammar (`+1`, `.5`, `0x1F`). */
  | 'normalized-number'
  /** A bare object key was quoted. */
  | 'quoted-key'
  /** A bare value was quoted as a string. */
  | 'quoted-value'
  /** A raw control character, inner quote or lone surrogate was escaped. */
  | 'escaped-character'
  /** An invalid escape sequence was corrected. */
  | 'fixed-escape'
  /** A string left open at end of input was closed. Lossless. */
  | 'terminated-string-at-eof'
  /** A string left open was closed at a line break. **Discards** the text after that line break. */
  | 'terminated-string-at-newline';

/** Every {@link RepairType}, in a stable order. Useful for exhaustive UIs and tests. */
export const REPAIR_TYPES = [
  'removed-byte-order-mark',
  'extracted-json',
  'removed-comment',
  'normalized-whitespace',
  'removed-trailing-comma',
  'removed-extra-comma',
  'removed-stray-token',
  'removed-trailing-content',
  'removed-incomplete-member',
  'added-missing-comma',
  'added-missing-colon',
  'added-missing-value',
  'added-closing-brace',
  'added-closing-bracket',
  'normalized-quotes',
  'normalized-literal',
  'normalized-number',
  'quoted-key',
  'quoted-value',
  'escaped-character',
  'fixed-escape',
  'terminated-string-at-eof',
  'terminated-string-at-newline',
] as const satisfies readonly RepairType[];

/**
 * A single change applied to the input.
 *
 * Positions locate the change in the **original** input string — they stay
 * absolute even when the JSON was extracted from a larger document, and they
 * include a leading byte order mark if one was present.
 */
export interface RepairOperation {
  /** What kind of change was made. */
  type: RepairType;
  /** Zero-based offset into the original input, in UTF-16 code units. */
  position?: number;
  /** One-based line number in the original input. */
  line?: number;
  /** One-based column number in the original input, in UTF-16 code units. */
  column?: number;
  /** Human-readable description, used by the CLI's `--explain` output. */
  message?: string;
}

/** Result of {@link repairJson} when `returnMetadata: true` is set. */
export interface RepairResult {
  /** Repaired JSON text. Guaranteed to be accepted by `JSON.parse`. */
  json: string;
  /** `true` when {@link RepairResult.json} differs from the input. */
  changed: boolean;
  /** Ordered list of the changes that were applied, ascending by position. */
  repairs: RepairOperation[];
}

/**
 * Options accepted by {@link repairJson} and {@link parseJson}.
 *
 * The boolean flags are tri-state: leaving one `undefined` uses the default for
 * the selected {@link RepairMode}, while an explicit `true` or `false` always
 * wins. Passing `false` therefore *disables* a repair — it does not mean
 * "use the default".
 */
export interface RepairOptions {
  /**
   * Repair strategy. Defaults to `'safe'`.
   * @see RepairMode
   */
  mode?: RepairMode;
  /**
   * Isolate JSON from Markdown code fences and surrounding prose before
   * repairing. Defaults to `true`.
   */
  extract?: boolean;
  /**
   * Accept and strip line comments, block comments and `#` comments.
   * Defaults to `true`.
   * When `false`, a comment is a syntax error rather than trivia.
   */
  allowComments?: boolean;
  /** Accept single-quoted strings. Defaults to `true`. */
  allowSingleQuotes?: boolean;
  /** Accept and quote bare object keys. Defaults to `true`. */
  allowUnquotedKeys?: boolean;
  /** Remove commas that directly precede `}` or `]`. Defaults to `true`. */
  fixTrailingCommas?: boolean;
  /** Close containers that were never closed. Defaults to `true`. */
  fixMissingBrackets?: boolean;
  /**
   * Maximum accepted input length, in UTF-16 code units (not bytes).
   * Defaults to `10_000_000`. Exceeding it throws `MAX_LENGTH_EXCEEDED`.
   */
  maxLength?: number;
  /**
   * Maximum accepted nesting depth. Defaults to `512`, and may not exceed
   * {@link MAX_SUPPORTED_DEPTH}. Exceeding it throws `MAX_DEPTH_EXCEEDED`,
   * which also keeps the parser clear of host stack limits.
   */
  maxDepth?: number;
  /**
   * Maximum number of repair operations per attempt. Defaults to `Infinity`;
   * the engine is single pass, so it terminates regardless of this value.
   */
  maxRepairs?: number;
  /** Return a {@link RepairResult} instead of a plain string. Defaults to `false`. */
  returnMetadata?: boolean;
}

/** Options accepted by {@link extractJson} and {@link extractAllJson}. */
export interface ExtractOptions extends Pick<
  RepairOptions,
  | 'mode'
  | 'allowComments'
  | 'allowSingleQuotes'
  | 'allowUnquotedKeys'
  | 'fixTrailingCommas'
  | 'fixMissingBrackets'
  | 'maxLength'
  | 'maxDepth'
  | 'maxRepairs'
> {
  /**
   * Which candidate {@link extractJson} returns when the document contains
   * several JSON blocks. Defaults to `'best'`, matching what
   * {@link repairJson} picks.
   *
   * - `best` — fewest repairs, then longest, then earliest. Prose decoys such
   *   as the `[1]` in "see [1] for details" lose to a real payload beside them.
   * - `first` — the earliest repairable candidate, in document order.
   * - `last` — the last repairable candidate, in document order.
   * - `largest` — the longest repairable candidate; ties resolve to the earliest.
   */
  select?: 'best' | 'first' | 'last' | 'largest';
}

/** Machine-readable reason a repair failed. */
export type JsonRepairErrorCode =
  /** Input was not a string, was empty/whitespace-only, or an option was invalid. */
  | 'INVALID_INPUT'
  /** No repairable JSON value could be located in the input. */
  | 'NO_JSON_FOUND'
  /** No safe repair sequence exists for this input. */
  | 'UNREPAIRABLE_JSON'
  /** Input exceeded `maxLength`. */
  | 'MAX_LENGTH_EXCEEDED'
  /** Nesting exceeded `maxDepth`. */
  | 'MAX_DEPTH_EXCEEDED'
  /** More repairs were required than `maxRepairs` allows. */
  | 'MAX_REPAIRS_EXCEEDED'
  /** Several readings are possible and `safe` mode refuses to choose. */
  | 'AMBIGUOUS_REPAIR';

/**
 * Hard ceiling for {@link RepairOptions.maxDepth}. Requesting more throws
 * `INVALID_INPUT`. The cap keeps the recursive parser well clear of host stack
 * limits on every supported runtime, so deep input always produces a
 * `MAX_DEPTH_EXCEEDED` error rather than a stack overflow.
 */
export const MAX_SUPPORTED_DEPTH = 1024;
