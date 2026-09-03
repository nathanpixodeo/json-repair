import type { RepairContext } from '../parser/state.js';
import { toLowerAscii } from '../scanner/tokens.js';

/** What {@link readLiteral} was able to do with a bare token. */
export type LiteralOutcome =
  /** The token was written to the output as a JSON literal. */
  | 'emitted'
  /** A reading exists, but only `mode: 'aggressive'` is willing to commit to it. */
  | 'needs-aggressive'
  /** The token is not a literal in any mode. */
  | 'not-a-literal';

/** How faithfully a non-JSON spelling of "no value" becomes `null`. */
type NullishKind =
  /** `None` — the same value under another language's spelling. */
  | 'equivalent'
  /** `NaN`, `Infinity`, `undefined` — `null` is the nearest JSON has, not the same value. */
  | 'lossy';

/**
 * Tries to emit the bare token spanning `[start, end)` as `true`, `false` or
 * `null`.
 *
 * Case variants of the three JSON literals are safe: `True` and `NULL` have no
 * second reading in a value position. `None` is safe for the same reason. It is
 * Python's spelling of `null` and nothing is lost in rewriting it, and the only
 * competing reading — the string `"None"` — requires unquoted string values,
 * which safe mode does not perform in the first place. Refusing `None` while
 * accepting `True` would also split the one Python dict repr that LLM output
 * produces constantly down the middle.
 *
 * `NaN`, `Infinity` and `undefined` stay aggressive-only, because for them
 * `null` is a lossy answer rather than a translation: the first two discard a
 * number the author did write, and `JSON.stringify` drops an `undefined` object
 * member entirely instead of nulling it, so two defensible readings exist.
 */
export function readLiteral(ctx: RepairContext, start: number, end: number): LiteralOutcome {
  const { source } = ctx.scanner;
  const length = end - start;

  if (length < 3 || length > 9) {
    return 'not-a-literal';
  }

  const canonical = matchJsonLiteral(source, start, end, length);
  if (canonical !== undefined) {
    if (matchesExactly(source, start, canonical)) {
      ctx.writeSpan(start, end);
    } else {
      ctx.write(canonical);
      ctx.record('normalized-literal', start, `Rewrote a literal as ${canonical}`);
    }
    return 'emitted';
  }

  const nullish = matchNullish(source, start, end, length);
  if (nullish === undefined) {
    return 'not-a-literal';
  }
  if (nullish === 'lossy' && !ctx.options.aggressive) {
    return 'needs-aggressive';
  }

  ctx.write('null');
  ctx.record('normalized-literal', start, 'Rewrote a non-JSON literal as null');
  return 'emitted';
}

/** Returns the canonical JSON literal a token spells in any case, if any. */
function matchJsonLiteral(
  source: string,
  start: number,
  end: number,
  length: number,
): string | undefined {
  if (length === 4) {
    if (matchesWord(source, start, end, 'true')) {
      return 'true';
    }
    if (matchesWord(source, start, end, 'null')) {
      return 'null';
    }
    return undefined;
  }
  if (length === 5 && matchesWord(source, start, end, 'false')) {
    return 'false';
  }
  return undefined;
}

/**
 * Classifies a token as one of the non-JSON spellings of "no value".
 *
 * @returns how faithfully the token maps to `null`, or `undefined` when it is
 * not one of these spellings at all.
 */
function matchNullish(
  source: string,
  start: number,
  end: number,
  length: number,
): NullishKind | undefined {
  switch (length) {
    case 3:
      return matchesWord(source, start, end, 'nan') ? 'lossy' : undefined;
    case 4:
      return matchesWord(source, start, end, 'none') ? 'equivalent' : undefined;
    case 8:
      return matchesWord(source, start, end, 'infinity') ? 'lossy' : undefined;
    case 9:
      return matchesWord(source, start, end, 'undefined') ||
        matchesWord(source, start, end, '-infinity')
        ? 'lossy'
        : undefined;
    default:
      return undefined;
  }
}

/**
 * Compares a span against a lower-case ASCII word, ignoring case.
 *
 * Uses code-unit arithmetic rather than `toLowerCase`, whose result depends on
 * the host locale — under a Turkish locale `"NULL".toLowerCase()` yields `null`
 * but `"I".toLowerCase()` yields `ı`, and the package guarantees identical
 * output on every machine.
 */
function matchesWord(source: string, start: number, end: number, word: string): boolean {
  if (end - start !== word.length) {
    return false;
  }
  for (let offset = 0; offset < word.length; offset += 1) {
    if (toLowerAscii(source.charCodeAt(start + offset)) !== word.charCodeAt(offset)) {
      return false;
    }
  }
  return true;
}

/** Reports whether a span is already exactly `word`. */
function matchesExactly(source: string, start: number, word: string): boolean {
  for (let offset = 0; offset < word.length; offset += 1) {
    if (source.charCodeAt(start + offset) !== word.charCodeAt(offset)) {
      return false;
    }
  }
  return true;
}
