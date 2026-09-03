import { createError } from './errors/JsonRepairError.js';
import { prepare, rankAttempts, solve, type Attempt } from './extract.js';
import { assertStructuralDepth } from './limits.js';
import { parseJsonStrict } from './native.js';
import { resolveOptions, type ResolvedOptions } from './options.js';
import { describeRepair } from './repair/messages.js';
import { Scanner } from './scanner/scanner.js';
import { isJsonWhitespace, isWhitespace } from './scanner/tokens.js';
import type { RepairOperation, RepairOptions, RepairResult, RepairType } from './types.js';

/**
 * A {@link RepairResult} plus the parsed value, which the validation stage has
 * already produced. Keeping it lets `parseJson` avoid a second full parse.
 */
export interface RepairOutcome extends RepairResult {
  value: unknown;
}

/**
 * Repairs malformed JSON and returns valid JSON text.
 *
 * Input that is already valid JSON is returned byte for byte, so this is safe to
 * call unconditionally on data that is usually fine.
 *
 * @throws {JsonRepairError} `INVALID_INPUT`, `NO_JSON_FOUND`, `UNREPAIRABLE_JSON`,
 * `AMBIGUOUS_REPAIR`, `MAX_LENGTH_EXCEEDED`, `MAX_DEPTH_EXCEEDED` or
 * `MAX_REPAIRS_EXCEEDED`.
 */
export function repairJson(
  input: string,
  options?: RepairOptions & { returnMetadata?: false },
): string;
/**
 * Repairs malformed JSON and reports what was changed.
 *
 * @throws {JsonRepairError} See the string-returning overload.
 */
export function repairJson(
  input: string,
  options: RepairOptions & { returnMetadata: true },
): RepairResult;
export function repairJson(input: string, options?: RepairOptions): string | RepairResult;
export function repairJson(input: string, options?: RepairOptions): string | RepairResult {
  const resolved = resolveOptions(options);
  const outcome = repairInternal(input, resolved);

  if (!resolved.returnMetadata) {
    return outcome.json;
  }

  return { json: outcome.json, changed: outcome.changed, repairs: outcome.repairs };
}

/**
 * The full repair pipeline, shared by every public entry point.
 *
 * The stages are ordered so that the cheapest one that can settle the question
 * runs first: reject bad input, try `JSON.parse` unchanged, and only then start
 * scanning.
 */
export function repairInternal(input: string, options: ResolvedOptions): RepairOutcome {
  const region = prepare(input, options);
  const fast = tryFastPath(input, region.start, options);
  if (fast !== undefined) {
    return fast;
  }

  const attempts = solve(input, region.start, region.end, options);
  const chosen = rankAttempts(attempts, 'best');

  const repairs = buildRepairLog(input, region, chosen);
  if (repairs.length > options.maxRepairs) {
    throw createError(
      'MAX_REPAIRS_EXCEEDED',
      `Repairing this input required ${repairs.length} changes, which exceeds the maximum of ${options.maxRepairs}.`,
      input,
      chosen.start,
    );
  }

  return {
    json: chosen.json,
    changed: chosen.json !== input,
    repairs,
    value: chosen.value,
  };
}

/**
 * Returns the input unchanged when it is already valid JSON.
 *
 * This is what keeps the package cheap to adopt: a caller can pipe every payload
 * through `repairJson` and pay one `JSON.parse` for the ones that were fine all
 * along, with a guarantee that valid input is never reformatted.
 *
 * A byte order mark is the one thing removed here. It is invisible, it makes
 * `JSON.parse` throw, and no caller has ever meant to keep it.
 *
 * @returns `undefined` when the input is not valid JSON, so the caller can fall
 * through to the repairing parser.
 */
function tryFastPath(
  input: string,
  regionStart: number,
  options: ResolvedOptions,
): RepairOutcome | undefined {
  const text = regionStart > 0 ? input.slice(regionStart) : input;

  let value: unknown;
  try {
    value = parseJsonStrict(text);
  } catch {
    // Not valid JSON, or valid but nested past what the host parser tolerates.
    // Either way the repairing parser is the right next step, and it enforces
    // `maxDepth` itself.
    return undefined;
  }

  // Deliberately outside the `try`, so a depth rejection propagates to the
  // caller instead of being mistaken for a parse failure.
  assertStructuralDepth(input, regionStart, input.length, options.maxDepth);

  const repairs: RepairOperation[] =
    regionStart > 0 ? [operation(new Scanner(input), 'removed-byte-order-mark', 0)] : [];

  if (repairs.length > options.maxRepairs) {
    throw createError(
      'MAX_REPAIRS_EXCEEDED',
      `Removing the byte order mark exceeds the maximum of ${options.maxRepairs} repairs.`,
      input,
      0,
    );
  }

  return { json: text, changed: regionStart > 0, repairs, value };
}

/**
 * Assembles the final repair log in ascending position order.
 *
 * The parser only knows about the value it was pointed at, so the three changes
 * that happen around it — the byte order mark, the prose before, the prose
 * after — are recorded here, where the surrounding document is still in view.
 */
function buildRepairLog(
  input: string,
  region: { start: number; end: number },
  chosen: Attempt,
): RepairOperation[] {
  const scanner = new Scanner(input);
  const repairs: RepairOperation[] = [];

  if (region.start > 0) {
    repairs.push(operation(scanner, 'removed-byte-order-mark', 0));
  }

  const before = classifyGap(input, region.start, chosen.start);
  if (before === 'content') {
    repairs.push(operation(scanner, 'extracted-json', chosen.start));
  } else if (before === 'exotic') {
    repairs.push(operation(scanner, 'normalized-whitespace', region.start));
  }

  for (const repair of chosen.repairs) {
    repairs.push(repair);
  }

  const after = classifyGap(input, chosen.end, region.end);
  if (after === 'content') {
    repairs.push(operation(scanner, 'removed-trailing-content', chosen.end));
  } else if (after === 'exotic') {
    repairs.push(operation(scanner, 'normalized-whitespace', chosen.end));
  }

  return repairs;
}

/**
 * Describes what sits in the input between the region and the chosen value.
 *
 * The distinction matters because dropping prose and dropping a stray
 * non-breaking space are different events for an auditor, and because either one
 * changes the output — leaving both unrecorded would let `changed` be `true`
 * with an empty repair log.
 */
function classifyGap(
  source: string,
  from: number,
  to: number,
): 'empty' | 'whitespace' | 'exotic' | 'content' {
  if (from >= to) {
    return 'empty';
  }

  let exotic = false;
  for (let index = from; index < to; index += 1) {
    const code = source.charCodeAt(index);
    if (!isWhitespace(code)) {
      return 'content';
    }
    if (!isJsonWhitespace(code)) {
      exotic = true;
    }
  }

  return exotic ? 'exotic' : 'whitespace';
}

/** Builds one fully located repair record. */
function operation(scanner: Scanner, type: RepairType, position: number): RepairOperation {
  const { line, column } = scanner.positionAt(position);
  return { type, position, line, column, message: describeRepair(type) };
}
