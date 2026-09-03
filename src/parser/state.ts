import { buildSnippet, JsonRepairError } from '../errors/JsonRepairError.js';
import type { ResolvedOptions } from '../options.js';
import { describeRepair } from '../repair/messages.js';
import type { Scanner } from '../scanner/scanner.js';
import { isWhitespace } from '../scanner/tokens.js';
import type { JsonRepairErrorCode, RepairOperation, RepairType } from '../types.js';

/**
 * Multiplier bounding the total work spent on string-continuation lookahead.
 *
 * Each candidate closing quote may trigger a bounded probe. Without a global
 * cap, input engineered to contain hundreds of thousands of quote characters
 * would turn a linear parse into a quadratic one. The budget scales with the
 * input, so the parse stays O(n) by construction; once it is exhausted probes
 * degrade to plain JSON behaviour (accept the closing quote), which is
 * deterministic and never produces invalid output.
 */
const PROBE_BUDGET_FACTOR = 4;

/** A point the parser can return to when a string turns out to be unterminated. */
export interface Checkpoint {
  /** Absolute offset to resume scanning from. */
  readonly index: number;
  /** Number of output chunks written at the time of the checkpoint. */
  readonly chunkCount: number;
  /** Number of repairs recorded at the time of the checkpoint. */
  readonly repairCount: number;
}

/**
 * Mutable state shared by the parser and every repair rule: the output being
 * built, the repair log, the depth counters and the resource budgets.
 *
 * One context serves exactly one parse attempt. The candidate loop in
 * `repair.ts` builds a fresh context per attempt, so a failed attempt can never
 * leak repairs or partial output into the next one.
 */
export class RepairContext {
  readonly scanner: Scanner;
  readonly options: ResolvedOptions;

  /** Repairs applied so far, in the order they were discovered. */
  readonly repairs: RepairOperation[] = [];

  /** Pieces of the output, joined once at the end. */
  private readonly chunks: string[] = [];

  /** Current nesting depth. */
  private depth = 0;

  /** Open `{` containers, used for O(1) stray-closer classification. */
  openBraces = 0;

  /** Open `[` containers, used for O(1) stray-closer classification. */
  openBrackets = 0;

  /** Remaining lookahead budget; see {@link PROBE_BUDGET_FACTOR}. */
  probeBudget: number;

  /**
   * Highest offset the parser has already rewound to.
   *
   * Rewinding is only ever allowed to move forward, which guarantees the parse
   * cannot loop between two readings of the same unterminated string.
   */
  lastRewind = -1;

  constructor(scanner: Scanner, options: ResolvedOptions) {
    this.scanner = scanner;
    this.options = options;
    this.probeBudget = (scanner.end - scanner.start) * PROBE_BUDGET_FACTOR;
  }

  /* ── Output ───────────────────────────────────────────────────────────── */

  /** Appends literal text to the output. */
  write(text: string): void {
    this.chunks.push(text);
  }

  /**
   * Appends a span of the original input verbatim.
   *
   * Copying spans rather than characters keeps the number of output chunks
   * proportional to the number of tokens, not to the length of the input.
   */
  writeSpan(from: number, to: number): void {
    if (to > from) {
      this.chunks.push(this.scanner.slice(from, to));
    }
  }

  /** Concatenates everything written so far. */
  output(): string {
    return this.chunks.join('');
  }

  /* ── Checkpoints ──────────────────────────────────────────────────────── */

  /** Captures the current output, repair log and cursor for a later rewind. */
  checkpoint(index: number): Checkpoint {
    return { index, chunkCount: this.chunks.length, repairCount: this.repairs.length };
  }

  /**
   * Reports whether the parser may rewind to `checkpoint`.
   *
   * Refusing a backwards rewind is what makes the unterminated-string heuristic
   * terminating: every rewind strictly advances the furthest point already
   * reconsidered.
   */
  canRewindTo(checkpoint: Checkpoint): boolean {
    return checkpoint.index > this.lastRewind;
  }

  /**
   * Returns the parser to `checkpoint`, discarding the output written and the
   * repairs recorded since it was taken, and marks the point as reconsidered.
   *
   * Truncating the repair log matters: without it, a rewound attempt would
   * report repairs that are not present in the text it finally emits.
   */
  rewindTo(checkpoint: Checkpoint): void {
    this.restore(checkpoint);
    this.lastRewind = checkpoint.index;
  }

  /**
   * Returns the parser to `checkpoint` without marking it as reconsidered.
   *
   * Used to un-write a construct the parser decided to drop rather than re-read
   * — a member truncated by a cut-off stream, for instance. Unlike
   * {@link rewindTo} these restores never re-scan the same text, so they cannot
   * loop and must not consume the rewind budget.
   */
  restore(checkpoint: Checkpoint): void {
    this.chunks.length = checkpoint.chunkCount;
    this.repairs.length = checkpoint.repairCount;
    this.scanner.index = checkpoint.index;
  }

  /**
   * Absolute offset of the last non-whitespace character in the region, or
   * `-1` if there is none.
   *
   * Computed once per parse. Recomputing it per token would make input such as
   * half a megabyte of `}` quadratic, which is precisely the shape an attacker
   * would send.
   */
  get lastContentIndex(): number {
    if (this.lastContentCache === -2) {
      this.lastContentCache = findLastContent(
        this.scanner.source,
        this.scanner.start,
        this.scanner.end,
      );
    }
    return this.lastContentCache;
  }

  private lastContentCache = -2;

  /* ── Repair log ───────────────────────────────────────────────────────── */

  /**
   * Records a repair at an absolute offset in the original input.
   *
   * @throws {JsonRepairError} `MAX_REPAIRS_EXCEEDED` once the budget is spent.
   */
  record(type: RepairType, position: number, message?: string): void {
    if (this.repairs.length >= this.options.maxRepairs) {
      throw this.error(
        'MAX_REPAIRS_EXCEEDED',
        `Input needs more than ${this.options.maxRepairs} repairs.`,
        position,
      );
    }

    const { line, column } = this.scanner.positionAt(position);
    this.repairs.push({
      type,
      position,
      line,
      column,
      message: message ?? describeRepair(type),
    });
  }

  /* ── Depth ────────────────────────────────────────────────────────────── */

  /**
   * Enters a nested container.
   *
   * @throws {JsonRepairError} `MAX_DEPTH_EXCEEDED` beyond the configured depth.
   */
  enter(position: number): void {
    this.depth += 1;
    if (this.depth > this.options.maxDepth) {
      throw this.error(
        'MAX_DEPTH_EXCEEDED',
        `Input nests deeper than the configured maximum of ${this.options.maxDepth}.`,
        position,
      );
    }
  }

  /** Leaves a nested container. */
  leave(): void {
    this.depth -= 1;
  }

  /* ── Failure ──────────────────────────────────────────────────────────── */

  /** Builds a positioned error without throwing it. */
  error(code: JsonRepairErrorCode, message: string, position: number): JsonRepairError {
    const { line, column } = this.scanner.positionAt(position);
    return new JsonRepairError(code, `${message} (line ${line}, column ${column})`, {
      position,
      line,
      column,
      snippet: buildSnippet(this.scanner.source, position),
    });
  }

  /**
   * Aborts the attempt because the input cannot be read as JSON at all.
   *
   * @throws {JsonRepairError} `UNREPAIRABLE_JSON`.
   */
  fail(message: string, position: number): never {
    throw this.error('UNREPAIRABLE_JSON', message, position);
  }

  /**
   * Aborts the attempt because safe mode declines to choose between readings.
   *
   * Callers reach this only when `mode: 'aggressive'` has a defined answer, so
   * the message always points at the escape hatch.
   *
   * @throws {JsonRepairError} `AMBIGUOUS_REPAIR`.
   */
  refuse(message: string, position: number): never {
    throw this.error(
      'AMBIGUOUS_REPAIR',
      `${message}; retry with mode: "aggressive" to apply a best-effort repair.`,
      position,
    );
  }
}

/** Returns the offset of the last non-whitespace character in a region, or `-1`. */
function findLastContent(source: string, start: number, end: number): number {
  for (let index = end - 1; index >= start; index -= 1) {
    if (!isWhitespace(source.charCodeAt(index))) {
      return index;
    }
  }
  return -1;
}
