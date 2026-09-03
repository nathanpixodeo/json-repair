import { createError, isJsonRepairError, type JsonRepairError } from './errors/JsonRepairError.js';
import { assertInputLength, assertString } from './limits.js';
import { parseJsonStrict } from './native.js';
import {
  resolveExtractOptions,
  withMode,
  type ResolvedOptions,
  type SelectStrategy,
} from './options.js';
import { parseDocument } from './parser/parser.js';
import { RepairContext } from './parser/state.js';
import {
  findValueStarts,
  scanFences,
  skipLeadingWhitespace,
  trimTrailingWhitespace,
} from './repair/markdown.js';
import { Scanner } from './scanner/scanner.js';
import {
  CH_BACKSLASH,
  CH_BOM,
  CH_CLOSE_BRACE,
  CH_CLOSE_BRACKET,
  CH_DOT,
  CH_MINUS,
  CH_OPEN_BRACE,
  CH_OPEN_BRACKET,
  CH_PLUS,
  isDigit,
  isQuote,
  toLowerAscii,
} from './scanner/tokens.js';
import type { ExtractOptions, RepairOperation } from './types.js';

/**
 * Largest number of candidate starts collected from a single region.
 *
 * Prose that happens to contain hundreds of braces is far more likely to be a
 * code sample than a hundred JSON payloads, and every extra candidate is a
 * potential extra parse. The cap keeps a pathological document from turning
 * extraction into a quadratic scan.
 */
const MAX_CANDIDATES = 256;

/**
 * Largest number of candidates that may fail before extraction gives up.
 *
 * Successful candidates are disjoint — each one advances a barrier past its own
 * end — so successes cost O(n) in total no matter how many there are. Only
 * failures can re-scan the same text, so only failures need a budget.
 */
const MAX_FAILED_ATTEMPTS = 32;

/** A region of the input that might hold a JSON value. */
export interface Candidate {
  /** Offset of the first character to parse. */
  start: number;
  /** Offset the parser may not read past. */
  limit: number;
}

/** A candidate that parsed and validated successfully. */
export interface Attempt {
  /** Offset of the candidate's first character in the original input. */
  start: number;
  /** Offset one past the last character the parser consumed. */
  end: number;
  /** Valid JSON text for this candidate. */
  json: string;
  /** The value {@link Attempt.json} parses to, reused by `parseJson`. */
  value: unknown;
  /** Changes applied while parsing this candidate. */
  repairs: RepairOperation[];
}

/**
 * Extracts the first — by default the best — JSON value embedded in a larger
 * document, and returns it **exactly as it appears in the input**.
 *
 * The text is returned verbatim rather than repaired, which keeps extraction
 * lossless: whitespace, key order and number formatting all survive. A
 * candidate still has to be repairable to be selected, and the default `best`
 * strategy prefers the longest one, so a decoy such as the `[1]` in "see [1]
 * for details" loses to a real payload beside it even though the decoy is
 * already valid and the payload needs work. The returned string may itself need
 * repairing before `JSON.parse` will take it.
 *
 * @throws {JsonRepairError} `INVALID_INPUT`, `MAX_LENGTH_EXCEEDED` or
 * `NO_JSON_FOUND` when no candidate could be repaired.
 */
export function extractJson(input: string, options?: ExtractOptions): string {
  const resolved = resolveExtractOptions(options);
  const region = prepare(input, resolved);
  const attempts = solve(input, region.start, region.end, resolved);
  const chosen = rankAttempts(attempts, resolved.select);

  return input.slice(chosen.start, chosen.end);
}

/**
 * Extracts every JSON value embedded in a document, in document order, each
 * returned verbatim as it appears in the input.
 *
 * Values nested inside an already-extracted value are not reported separately,
 * so a document containing `[{"a":1}]` yields the array, not the array and then
 * its element.
 *
 * Returns an empty array when the document holds no repairable JSON. Unlike
 * {@link extractJson} this never throws `NO_JSON_FOUND`, because "nothing here"
 * is an ordinary answer when the caller asked for everything.
 *
 * @throws {JsonRepairError} `INVALID_INPUT` or `MAX_LENGTH_EXCEEDED`.
 */
export function extractAllJson(input: string, options?: ExtractOptions): string[] {
  const resolved = resolveExtractOptions(options);
  const region = prepare(input, resolved);

  let attempts: Attempt[];
  try {
    attempts = solve(input, region.start, region.end, resolved);
  } catch (error) {
    if (isJsonRepairError(error) && error.code === 'NO_JSON_FOUND') {
      return [];
    }
    throw error;
  }

  return attempts.map((attempt) => input.slice(attempt.start, attempt.end));
}

/**
 * Validates the input and locates the region to scan.
 *
 * A leading byte order mark is excluded from the region rather than stripped, so
 * that every offset the engine reports still refers to the caller's own string.
 */
export function prepare(input: string, options: ResolvedOptions): { start: number; end: number } {
  assertString(input, 'input');
  assertInputLength(input, options.maxLength);

  return {
    start: input.length > 0 && input.charCodeAt(0) === CH_BOM ? 1 : 0,
    end: input.length,
  };
}

/**
 * Finds every JSON value in a region, trying safe repairs before aggressive
 * ones.
 *
 * The two-phase order matters for documents that mix prose and JSON. Given
 * `[2024-01-01 12:00:00] {"level":"info"}`, an aggressive-only pass would happily
 * quote the bare timestamp and return the leading bracket group. Running safe
 * mode across every candidate first means the real object wins, and the
 * aggressive pass only runs when nothing at all parsed cleanly.
 *
 * @returns Successful attempts in document order; never empty.
 * @throws {JsonRepairError} The most relevant failure, or `NO_JSON_FOUND`.
 */
export function solve(
  source: string,
  start: number,
  end: number,
  options: ResolvedOptions,
): Attempt[] {
  const tiers = buildCandidateTiers(source, start, end, options);

  const safe = collectAttempts(source, tiers, withMode(options, 'safe'));
  if (safe.attempts.length > 0) {
    return safe.attempts;
  }

  if (!options.aggressive) {
    throw safe.error ?? noJsonFound(source, start);
  }

  const loose = collectAttempts(source, tiers, options);
  if (loose.attempts.length > 0) {
    return loose.attempts;
  }

  throw loose.error ?? safe.error ?? noJsonFound(source, start);
}

/**
 * Groups candidate starts into tiers, most trustworthy first.
 *
 * Tiers are tried in order and the first one that yields any result wins, which
 * encodes an ordering of evidence: text a model deliberately tagged as JSON
 * beats text merely fenced as code, which beats a brace found loose in prose.
 * Without the tiering, a `{` inside an English sentence would compete on equal
 * terms with the payload the caller actually wants.
 *
 * Fence candidates are bounded by the fence body, so an unterminated string
 * inside a fenced block stops at the closing fence instead of swallowing the
 * rest of the document.
 */
export function buildCandidateTiers(
  source: string,
  start: number,
  end: number,
  options: ResolvedOptions,
): Candidate[][] {
  const whole = wholeRegionCandidate(source, start, end);

  if (!options.extract) {
    return whole === undefined ? [] : [[whole]];
  }

  const tagged: Candidate[] = [];
  const fenced: Candidate[] = [];

  for (const fence of scanFences(source, start, end)) {
    const target = fence.jsonTagged ? tagged : fenced;
    const starts = findValueStarts(source, fence.bodyStart, fence.bodyEnd, MAX_CANDIDATES);

    for (const offset of starts) {
      target.push({ start: offset, limit: fence.bodyEnd });
    }

    if (starts.length === 0) {
      // A fence may hold a top-level scalar, such as a bare quoted string.
      const body = wholeRegionCandidate(source, fence.bodyStart, fence.bodyEnd);
      if (body !== undefined) {
        target.push(body);
      }
    }
  }

  const bare: Candidate[] = findValueStarts(source, start, end, MAX_CANDIDATES).map((offset) => ({
    start: offset,
    limit: end,
  }));

  const tiers: Candidate[][] = [];
  for (const tier of [tagged, fenced, bare]) {
    if (tier.length > 0) {
      tiers.push(tier);
    }
  }
  // The whole region is the last resort, for a document that is nothing but a
  // top-level scalar. It is gated on the region actually looking like a value:
  // without the gate, ordinary prose reaches the parser and fails with a
  // syntax-level complaint about its first word, when the honest answer to
  // "find me the JSON in this text" is that there is none.
  if (whole !== undefined && startsJsonValue(source, whole.start, end)) {
    tiers.push([whole]);
  }

  return tiers;
}

/** Literal words a JSON-ish document may open with, lower case. */
const VALUE_WORDS = ['true', 'false', 'null', 'nan', 'none', 'infinity', 'undefined'];

/** Reports whether a region plausibly begins a JSON value. */
function startsJsonValue(source: string, from: number, end: number): boolean {
  const code = source.charCodeAt(from);

  if (
    code === CH_OPEN_BRACE ||
    code === CH_OPEN_BRACKET ||
    code === CH_MINUS ||
    code === CH_PLUS ||
    code === CH_DOT ||
    isDigit(code) ||
    isQuote(code)
  ) {
    return true;
  }

  return VALUE_WORDS.some((word) => matchesWord(source, from, end, word));
}

/** Reports whether `word` appears at `from`, compared without case or locale. */
function matchesWord(source: string, from: number, end: number, word: string): boolean {
  if (from + word.length > end) {
    return false;
  }
  for (let index = 0; index < word.length; index += 1) {
    if (toLowerAscii(source.charCodeAt(from + index)) !== word.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}

/**
 * Runs a tier at a time until one produces results.
 *
 * Within a tier, candidates are tried in document order and a success advances a
 * barrier past its own end, so nested values are skipped rather than reported
 * twice. The failure budget is shared across tiers because it exists to bound
 * total work, not work per tier.
 */
function collectAttempts(
  source: string,
  tiers: readonly Candidate[][],
  options: ResolvedOptions,
): { attempts: Attempt[]; error: JsonRepairError | undefined } {
  let firstError: JsonRepairError | undefined;
  let failures = 0;

  for (const tier of tiers) {
    const attempts: Attempt[] = [];
    let barrier = -1;

    for (const candidate of tier) {
      if (candidate.start < barrier) {
        continue;
      }
      if (failures >= MAX_FAILED_ATTEMPTS) {
        break;
      }

      let attempt: Attempt;
      try {
        attempt = tryCandidate(source, candidate, options);
      } catch (error) {
        if (!isJsonRepairError(error)) {
          // Anything other than a JsonRepairError is a defect in this package,
          // not a property of the input. Surfacing it beats hiding it behind a
          // generic "no JSON found".
          throw error;
        }
        failures += 1;
        firstError ??= error;
        // Everything inside the container this candidate opened is a fragment
        // of it, not a document in its own right. Without this the array in
        // `{"a": None, "b": [1, 2]}` would be accepted the moment the object
        // around it failed, quietly returning a piece of the input as if it
        // were the whole answer.
        barrier = Math.max(barrier, findStructuralEnd(source, candidate.start, candidate.limit));
        continue;
      }

      attempts.push(attempt);
      barrier = Math.max(barrier, attempt.end);
    }

    if (attempts.length > 0) {
      return { attempts, error: undefined };
    }
  }

  return { attempts: [], error: firstError };
}

/**
 * Finds where the container opened at `start` ends, by matching brackets.
 *
 * This is a balance scan, not a parse: it only has to answer "which later
 * candidate starts are inside this one", and it has to answer it for input the
 * parser has already rejected. Quoted text is skipped so a brace inside a
 * string cannot move the answer, and all three quote characters the repairer
 * accepts count as quotes here for the same reason.
 *
 * Closers are matched against the open containers rather than merely counted,
 * mirroring what the parser itself does with a mismatched closer: one that
 * matches an outer frame closes the frames between, and one that matches
 * nothing on the stack is stray and ignored. Plain counting would let the `]`
 * in `{] "b": [1,2]}` cancel the opening brace, put the barrier two characters
 * in, and hand the caller the inner `[1,2]` as if it were the document.
 *
 * @returns the offset one past the matching closer, or `end` when the container
 * is never closed — in which case everything that follows really is inside it.
 */
function findStructuralEnd(source: string, start: number, end: number): number {
  // Bounded by the structural-depth precheck, which runs over the whole input
  // before any candidate is tried, so this cannot grow with the input length.
  const open: number[] = [];

  for (let index = start; index < end; index += 1) {
    const code = source.charCodeAt(index);

    if (isQuote(code)) {
      index += 1;
      while (index < end) {
        const inner = source.charCodeAt(index);
        if (inner === CH_BACKSLASH) {
          index += 1;
        } else if (inner === code) {
          break;
        }
        index += 1;
      }
      continue;
    }

    if (code === CH_OPEN_BRACE || code === CH_OPEN_BRACKET) {
      open.push(code);
      continue;
    }

    if (code !== CH_CLOSE_BRACE && code !== CH_CLOSE_BRACKET) {
      continue;
    }

    const opener = code === CH_CLOSE_BRACE ? CH_OPEN_BRACE : CH_OPEN_BRACKET;
    const frame = open.lastIndexOf(opener);
    if (frame < 0) {
      // Stray closer: nothing it could be closing is open.
      continue;
    }

    open.length = frame;
    if (open.length === 0) {
      return index + 1;
    }
  }

  return end;
}

/** Parses one candidate and validates the result. */
function tryCandidate(source: string, candidate: Candidate, options: ResolvedOptions): Attempt {
  const scanner = new Scanner(source, candidate.start, candidate.limit);
  const context = new RepairContext(scanner, options);

  parseDocument(context);

  const end = scanner.index;
  const { repairs } = context;

  if (repairs.length === 0) {
    // Nothing was repaired, so the source text is already valid JSON. Returning
    // it untouched preserves the author's formatting instead of silently
    // reflowing a pretty-printed payload into a single line.
    const slice = source.slice(candidate.start, end);
    const parsed = tryParse(slice);
    if (parsed !== undefined) {
      return { start: candidate.start, end, json: slice, value: parsed.value, repairs };
    }
  }

  const json = context.output();
  const parsed = tryParse(json);
  if (parsed === undefined) {
    throw createError(
      'UNREPAIRABLE_JSON',
      'The repaired output is not valid JSON. This is a defect in @nexkit/json-repair; ' +
        'please report it along with the input that triggered it.',
      source,
      candidate.start,
    );
  }

  return { start: candidate.start, end, json, value: parsed.value, repairs };
}

/**
 * Chooses one attempt from a set of successful ones.
 *
 * Attempts arrive in document order, and every comparison below is strict, so
 * ties always resolve to the earliest candidate. That is what makes the choice
 * deterministic rather than dependent on iteration order.
 */
export function rankAttempts(attempts: readonly Attempt[], select: SelectStrategy): Attempt {
  const first = attempts[0];
  if (first === undefined) {
    throw new Error('rankAttempts requires at least one attempt');
  }

  if (select === 'first') {
    return first;
  }
  if (select === 'last') {
    return attempts[attempts.length - 1]!;
  }

  let best = first;
  for (let index = 1; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    if (select === 'largest' ? isLarger(attempt, best) : isBetter(attempt, best)) {
      best = attempt;
    }
  }

  return best;
}

/**
 * Longest span wins; among equal spans, fewest repairs wins.
 *
 * Span has to dominate. A document's real payload is the big thing in it, while
 * a decoy — the `[1]` of "see [1] for details", or an array nested inside an
 * object that needed one fix — is small and frequently already valid on its
 * own. Ranking by repair count first would hand the caller the decoy and
 * silently drop the payload, which is the one failure mode worse than throwing.
 */
function isBetter(attempt: Attempt, best: Attempt): boolean {
  const span = attempt.end - attempt.start;
  const bestSpan = best.end - best.start;
  if (span !== bestSpan) {
    return span > bestSpan;
  }
  return attempt.repairs.length < best.repairs.length;
}

/** Longest span wins. */
function isLarger(attempt: Attempt, best: Attempt): boolean {
  return attempt.end - attempt.start > best.end - best.start;
}

/** Wraps a whole region as a single candidate, or `undefined` if it is blank. */
function wholeRegionCandidate(source: string, start: number, end: number): Candidate | undefined {
  const from = skipLeadingWhitespace(source, start, end);
  const to = trimTrailingWhitespace(source, from, end);

  return from < to ? { start: from, limit: end } : undefined;
}

/** Parses text without letting a `SyntaxError` escape. */
function tryParse(text: string): { value: unknown } | undefined {
  try {
    return { value: parseJsonStrict(text) };
  } catch {
    return undefined;
  }
}

/** Builds the error used when a document holds nothing repairable. */
function noJsonFound(source: string, position: number): JsonRepairError {
  return createError('NO_JSON_FOUND', 'No JSON value was found in the input.', source, position);
}
