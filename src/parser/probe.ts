import { scanTrivia } from '../repair/comments.js';
import {
  CH_BACKSLASH,
  CH_CLOSE_BRACE,
  CH_CLOSE_BRACKET,
  CH_COLON,
  CH_COMMA,
  CH_MINUS,
  CH_OPEN_BRACE,
  CH_OPEN_BRACKET,
  CH_PLUS,
  CH_DOT,
  closersFor,
  isDigit,
  isIdentifierPart,
  isIdentifierStart,
  isQuote,
} from '../scanner/tokens.js';
import type { RepairContext } from './state.js';

/**
 * Where in the grammar a string that just closed was sitting.
 *
 * `document` is the top-level value; it is probed like an array element, which
 * makes a bare word after the quote (`"he said "hi" today"`) reject the close
 * while a closing punctuation mark or end of input accepts it.
 */
export type Slot = 'object-key' | 'object-value' | 'array-element' | 'document';

/**
 * Characters of lookahead a single probe may consume.
 *
 * Wide enough for a comma, a long key and a colon; narrow enough that a string
 * containing many quote characters cannot turn the parse quadratic. The global
 * `RepairContext.probeBudget` bounds the total across all probes as well.
 */
const PROBE_WINDOW = 256;

/** {@link scanString}/{@link scanValueToken} hit the end of input with no terminator. */
const SCAN_UNTERMINATED = -1;

/** {@link scanString}/{@link scanValueToken} ran past the lookahead window. */
const SCAN_BUDGET = -2;

/**
 * Decides whether a quote character really closes the string, by checking that
 * what follows could continue the enclosing container.
 *
 * This is the heart of the inner-quote heuristic. Given `{"a": "he said "hi",
 * ok"}` a naive parser closes the value at `"he said "` and then chokes; a
 * parser that accepts any quote followed by a comma closes it at `"hi"` and
 * silently drops `ok`. Both are wrong. Probing asks the only question that
 * distinguishes them — *does a well-formed continuation start here?* — and the
 * answer is no in both cases, because ` ok"` is not a key followed by a colon.
 * The string therefore runs to the final quote, and the inner ones become
 * escaped content.
 *
 * The probe is read-only and bounded: on running out of budget it accepts the
 * close, which is what a plain JSON parser would have done anyway.
 *
 * @param from Absolute offset immediately after the candidate closing quote.
 */
export function probeContinuation(ctx: RepairContext, from: number, slot: Slot): boolean {
  if (ctx.probeBudget <= 0) {
    return true;
  }

  const { source, end } = ctx.scanner;
  const window = end < from + PROBE_WINDOW ? end : from + PROBE_WINDOW;
  const allowComments = ctx.options.allowComments;
  const aggressive = ctx.options.aggressive;

  const index = scanTrivia(source, from, window, allowComments);
  ctx.probeBudget -= index - from + 1;

  // Reaching the true end of the region means the string ended the document.
  if (index >= end) {
    return true;
  }
  if (index >= window) {
    return true;
  }

  const code = source.charCodeAt(index);

  switch (slot) {
    case 'object-key':
      if (code === CH_COLON) {
        return true;
      }
      // `{"a", "b": 1}` only has a reading once missing colons may be invented.
      return aggressive && (code === CH_COMMA || code === CH_CLOSE_BRACE);

    case 'object-value':
      if (code === CH_CLOSE_BRACE || code === CH_CLOSE_BRACKET) {
        return true;
      }
      if (code === CH_COMMA) {
        return looksLikeMember(ctx, index + 1, window, allowComments);
      }
      // A key starting straight after the value means a comma went missing.
      if (isQuote(code) || isIdentifierStart(code)) {
        return looksLikeMember(ctx, index, window, allowComments);
      }
      return false;

    case 'array-element':
    case 'document':
      if (code === CH_CLOSE_BRACKET || code === CH_CLOSE_BRACE) {
        return true;
      }
      if (code === CH_COMMA) {
        return looksLikeElement(ctx, index + 1, window, allowComments);
      }
      if (isQuote(code)) {
        return looksLikeElement(ctx, index, window, allowComments);
      }
      return false;

    default:
      return true;
  }
}

/** Reports whether `from` plausibly starts `key :` inside an object. */
function looksLikeMember(
  ctx: RepairContext,
  from: number,
  window: number,
  allowComments: boolean,
): boolean {
  const { source, end } = ctx.scanner;

  const keyStart = scanTrivia(source, from, window, allowComments);
  ctx.probeBudget -= keyStart - from + 1;

  if (keyStart >= end || keyStart >= window) {
    return true;
  }

  const code = source.charCodeAt(keyStart);
  // A closing brace or another comma still leaves a well-formed member list.
  if (code === CH_CLOSE_BRACE || code === CH_COMMA) {
    return true;
  }

  const keyEnd = scanKey(source, keyStart, window, end);
  ctx.probeBudget -= (keyEnd < 0 ? window - keyStart : keyEnd - keyStart) + 1;

  if (keyEnd === SCAN_BUDGET) {
    return true;
  }
  if (keyEnd < 0) {
    return false;
  }

  const afterKey = scanTrivia(source, keyEnd, window, allowComments);
  if (afterKey >= end || afterKey >= window) {
    return true;
  }
  return source.charCodeAt(afterKey) === CH_COLON;
}

/** Reports whether `from` plausibly starts an array element followed by `,` or `]`. */
function looksLikeElement(
  ctx: RepairContext,
  from: number,
  window: number,
  allowComments: boolean,
): boolean {
  const { source, end } = ctx.scanner;

  const valueStart = scanTrivia(source, from, window, allowComments);
  ctx.probeBudget -= valueStart - from + 1;

  if (valueStart >= end || valueStart >= window) {
    return true;
  }

  const code = source.charCodeAt(valueStart);
  // A closing bracket or another comma still leaves a well-formed element list.
  if (code === CH_CLOSE_BRACKET || code === CH_COMMA) {
    return true;
  }

  const valueEnd = scanValueToken(source, valueStart, window, end);
  ctx.probeBudget -= (valueEnd < 0 ? window - valueStart : valueEnd - valueStart) + 1;

  if (valueEnd === SCAN_BUDGET) {
    return true;
  }
  if (valueEnd < 0) {
    return false;
  }

  const afterValue = scanTrivia(source, valueEnd, window, allowComments);
  if (afterValue >= end || afterValue >= window) {
    return true;
  }
  const next = source.charCodeAt(afterValue);
  return next === CH_COMMA || next === CH_CLOSE_BRACKET;
}

/** Returns the offset after a quoted or bare key, or a negative scan code. */
function scanKey(source: string, from: number, window: number, end: number): number {
  const code = source.charCodeAt(from);
  if (isQuote(code)) {
    return scanString(source, from, window, end);
  }
  if (!isIdentifierStart(code)) {
    return SCAN_UNTERMINATED;
  }

  let index = from + 1;
  while (index < window && isIdentifierPart(source.charCodeAt(index))) {
    index += 1;
  }
  return index >= window && index < end ? SCAN_BUDGET : index;
}

/** Returns the offset after one value token, or a negative scan code. */
function scanValueToken(source: string, from: number, window: number, end: number): number {
  const code = source.charCodeAt(from);

  if (isQuote(code)) {
    return scanString(source, from, window, end);
  }
  // A nested container is a value; its own contents are not this probe's problem.
  if (code === CH_OPEN_BRACE || code === CH_OPEN_BRACKET) {
    return SCAN_BUDGET;
  }
  if (!isDigit(code) && !isIdentifierStart(code) && code !== CH_MINUS && code !== CH_PLUS) {
    return SCAN_UNTERMINATED;
  }

  let index = from + 1;
  while (index < window) {
    const next = source.charCodeAt(index);
    if (!isIdentifierPart(next) && !isDigit(next) && next !== CH_PLUS && next !== CH_DOT) {
      break;
    }
    index += 1;
  }
  return index >= window && index < end ? SCAN_BUDGET : index;
}

/** Returns the offset after a string literal, or a negative scan code. */
function scanString(source: string, from: number, window: number, end: number): number {
  const opener = source.charCodeAt(from);
  const closers = closersFor(opener);

  let index = from + 1;
  while (index < window) {
    const code = source.charCodeAt(index);
    if (code === CH_BACKSLASH) {
      index += 2;
      continue;
    }
    if (code === closers[0] || code === closers[1]) {
      return index + 1;
    }
    index += 1;
  }
  return index >= end ? SCAN_UNTERMINATED : SCAN_BUDGET;
}
