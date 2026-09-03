import { createError, JsonRepairError } from './errors/JsonRepairError.js';
import {
  CH_BACKSLASH,
  CH_CLOSE_BRACE,
  CH_CLOSE_BRACKET,
  CH_DOUBLE_QUOTE,
  CH_OPEN_BRACE,
  CH_OPEN_BRACKET,
} from './scanner/tokens.js';

/**
 * Rejects an input that is not a string.
 *
 * This runs before anything touches the value, so a caller who accidentally
 * passes an already-parsed object or a `Buffer` gets a named error rather than
 * a confusing failure deep inside the scanner.
 *
 * @throws {JsonRepairError} `INVALID_INPUT`
 */
export function assertString(input: unknown, parameter: string): asserts input is string {
  if (typeof input !== 'string') {
    throw new JsonRepairError(
      'INVALID_INPUT',
      `Parameter "${parameter}" must be a string, received ${input === null ? 'null' : typeof input}.`,
    );
  }
}

/**
 * Rejects an input longer than the configured budget.
 *
 * The check happens before any scanning, so an oversized payload costs one
 * property read rather than a full pass.
 *
 * @throws {JsonRepairError} `MAX_LENGTH_EXCEEDED`
 */
export function assertInputLength(input: string, maxLength: number): void {
  if (input.length > maxLength) {
    throw new JsonRepairError(
      'MAX_LENGTH_EXCEEDED',
      `Input is ${input.length} characters, which exceeds the maximum of ${maxLength}.`,
      { position: maxLength },
    );
  }
}

/**
 * Enforces `maxDepth` on text that `JSON.parse` has already accepted.
 *
 * The repairing parser tracks depth as it descends, but the fast path never
 * enters the parser, so valid input needs its own check or `maxDepth` would be
 * silently unenforced for exactly the documents most likely to be deep.
 *
 * Because the text is known-valid JSON, string boundaries are unambiguous: a
 * quote is either the delimiter or escaped, with no repair cases to consider.
 * That makes a single linear pass exact.
 *
 * @throws {JsonRepairError} `MAX_DEPTH_EXCEEDED`
 */
export function assertStructuralDepth(
  source: string,
  start: number,
  end: number,
  maxDepth: number,
): void {
  let depth = 0;
  let index = start;

  while (index < end) {
    const code = source.charCodeAt(index);

    if (code === CH_DOUBLE_QUOTE) {
      index = skipValidString(source, index + 1, end);
      continue;
    }

    if (code === CH_OPEN_BRACE || code === CH_OPEN_BRACKET) {
      depth += 1;
      if (depth > maxDepth) {
        throw createError(
          'MAX_DEPTH_EXCEEDED',
          `Nesting depth exceeds the maximum of ${maxDepth}.`,
          source,
          index,
        );
      }
    } else if (code === CH_CLOSE_BRACE || code === CH_CLOSE_BRACKET) {
      depth -= 1;
    }

    index += 1;
  }
}

/**
 * Returns the offset one past the closing quote of a string whose opening quote
 * has already been consumed. Only valid on text `JSON.parse` has accepted.
 */
function skipValidString(source: string, from: number, end: number): number {
  let index = from;

  while (index < end) {
    const code = source.charCodeAt(index);
    if (code === CH_BACKSLASH) {
      index += 2;
      continue;
    }
    if (code === CH_DOUBLE_QUOTE) {
      return index + 1;
    }
    index += 1;
  }

  return end;
}
