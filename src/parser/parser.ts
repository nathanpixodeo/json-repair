import { closeUnterminated, dropStrayCloser } from '../repair/brackets.js';
import { skipTrivia } from '../repair/comments.js';
import { readLiteral } from '../repair/literals.js';
import { readNumber } from '../repair/numbers.js';
import { readString, writeQuotedSpan } from '../repair/quotes.js';
import { readSeparator } from '../repair/trailing-comma.js';
import {
  CH_ASTERISK,
  CH_CLOSE_BRACE,
  CH_CLOSE_BRACKET,
  CH_COLON,
  CH_COMMA,
  CH_DOUBLE_QUOTE,
  CH_EOF,
  CH_HASH,
  CH_OPEN_BRACE,
  CH_OPEN_BRACKET,
  CH_SLASH,
  isIdentifierPart,
  isIdentifierStart,
  isQuote,
  isStructural,
  isWhitespace,
} from '../scanner/tokens.js';
import type { Slot } from './probe.js';
import type { RepairContext } from './state.js';

/**
 * Outcome of parsing one value.
 *
 * `dropped` means the construct was cut off by the end of the input, nothing
 * was written, and the cursor now sits at the end of the region. Streamed
 * output that stops mid-token is the reason this exists: emitting a husk such
 * as `{"name"` is impossible, and failing outright would throw away everything
 * that did arrive, so the truncated tail is discarded and reported.
 */
export type ParseStatus = 'ok' | 'dropped';

/**
 * Parses one complete JSON value starting at the cursor, writing the repaired
 * text into the context.
 *
 * The cursor is left immediately after the value; anything beyond it is the
 * caller's concern.
 *
 * @throws {JsonRepairError} when the input cannot be read as JSON in the active mode.
 */
export function parseDocument(ctx: RepairContext): void {
  skipTrivia(ctx);

  if (ctx.scanner.eof()) {
    throw ctx.error('NO_JSON_FOUND', 'No JSON value found', ctx.scanner.index);
  }

  if (parseValue(ctx, 'document', false) === 'dropped') {
    throw ctx.error('NO_JSON_FOUND', 'No JSON value found', ctx.scanner.index);
  }
}

/**
 * Parses a single value.
 *
 * @param mayDrop Whether an entirely truncated container may be discarded. The
 * top-level value never can: `[{` still has to produce `[]` rather than
 * nothing at all.
 */
export function parseValue(ctx: RepairContext, slot: Slot, mayDrop: boolean): ParseStatus {
  const { scanner } = ctx;

  for (;;) {
    skipTrivia(ctx);

    const start = scanner.index;
    const code = scanner.peek();

    if (code === CH_EOF) {
      return 'dropped';
    }
    if (code === CH_OPEN_BRACE) {
      return parseObject(ctx, mayDrop);
    }
    if (code === CH_OPEN_BRACKET) {
      return parseArray(ctx, mayDrop);
    }
    if (isQuote(code)) {
      if (code !== CH_DOUBLE_QUOTE && !ctx.options.allowSingleQuotes) {
        ctx.fail('Non-standard string delimiter, and allowSingleQuotes is disabled', start);
      }
      readString(ctx, slot);
      return 'ok';
    }
    if (
      code === CH_CLOSE_BRACE ||
      code === CH_CLOSE_BRACKET ||
      code === CH_COMMA ||
      code === CH_COLON
    ) {
      // The value is simply absent: `{"a":}` or `[1,,2]`.
      if (!ctx.options.aggressive) {
        ctx.refuse('Expected a value', start);
      }
      ctx.write('null');
      ctx.record('added-missing-value', start);
      return 'ok';
    }

    const coreEnd = scanCoreToken(ctx, start);
    if (coreEnd > start) {
      return parseBareValue(ctx, start, coreEnd);
    }

    // A character that cannot begin anything. Dropping it is the only way to
    // make progress, and only aggressive mode is willing to.
    if (!ctx.options.aggressive) {
      ctx.fail(`Unexpected character ${describeChar(scanner.source, start)}`, start);
    }
    ctx.record('removed-stray-token', start);
    scanner.index = start + 1;
  }
}

/* ── Objects ────────────────────────────────────────────────────────────── */

function parseObject(ctx: RepairContext, mayDrop: boolean): ParseStatus {
  const { scanner } = ctx;
  const openPosition = scanner.index;
  const entry = ctx.checkpoint(openPosition);

  scanner.index += 1;
  ctx.enter(openPosition);
  ctx.openBraces += 1;
  ctx.write('{');

  let members = 0;
  let closed = false;
  let truncated = false;
  let previousIndex = -1;

  for (;;) {
    skipTrivia(ctx);

    if (scanner.index === previousIndex) {
      ctx.fail('Parser made no progress', scanner.index);
    }
    previousIndex = scanner.index;

    const code = scanner.peek();

    if (code === CH_EOF) {
      closeUnterminated(ctx, 'object', scanner.index);
      truncated = true;
      break;
    }
    if (code === CH_CLOSE_BRACE) {
      scanner.index += 1;
      closed = true;
      break;
    }
    if (code === CH_CLOSE_BRACKET) {
      if (ctx.openBrackets > 0) {
        // An enclosing array is waiting for this bracket; close the object here
        // and leave the bracket for its owner.
        closeUnterminated(ctx, 'object', scanner.index);
        break;
      }
      dropStrayCloser(ctx);
      continue;
    }
    if (code === CH_COMMA) {
      // Leading or repeated commas carry no meaning between named members.
      ctx.record('removed-extra-comma', scanner.index);
      scanner.index += 1;
      continue;
    }

    if (!canStartKey(ctx, code)) {
      if (!ctx.options.aggressive) {
        ctx.fail(
          `Expected an object key, found ${describeChar(scanner.source, scanner.index)}`,
          scanner.index,
        );
      }
      ctx.record('removed-stray-token', scanner.index);
      scanner.index += 1;
      continue;
    }

    const slot = ctx.checkpoint(scanner.index);
    if (members > 0) {
      ctx.write(',');
    }

    if (parseMember(ctx) === 'dropped') {
      ctx.restore(slot);
      scanner.index = scanner.end;
      ctx.record('removed-incomplete-member', slot.index);
      closeUnterminated(ctx, 'object', slot.index);
      truncated = true;
      break;
    }

    members += 1;
    readSeparator(ctx);
  }

  ctx.write('}');
  ctx.openBraces -= 1;
  ctx.leave();

  if (mayDrop && truncated && !closed && members === 0) {
    // An opening brace and nothing else: the stream was cut before any content.
    ctx.restore(entry);
    scanner.index = scanner.end;
    return 'dropped';
  }
  return 'ok';
}

/** Parses `key : value`, writing both. */
function parseMember(ctx: RepairContext): ParseStatus {
  const { scanner } = ctx;

  parseKey(ctx);
  skipTrivia(ctx);

  const afterKey = scanner.index;
  const next = scanner.peek();

  if (next === CH_EOF) {
    return 'dropped';
  }

  if (next === CH_COLON) {
    scanner.index += 1;
  } else if (next === CH_CLOSE_BRACE || next === CH_COMMA) {
    // A key with nothing after it: `{"a", "b": 1}`.
    if (!ctx.options.aggressive) {
      ctx.refuse('Object key has no value', afterKey);
    }
    ctx.record('added-missing-colon', afterKey);
    ctx.write(':null');
    ctx.record('added-missing-value', afterKey);
    return 'ok';
  } else if (isQuote(next)) {
    // `{"a" "b"}` could be a missing colon or a missing comma between two keys.
    if (!ctx.options.aggressive) {
      ctx.refuse('Expected ":" between key and value', afterKey);
    }
    ctx.record('added-missing-colon', afterKey);
  } else {
    // `{"a" 1}` has only one reading: the colon was dropped.
    ctx.record('added-missing-colon', afterKey);
  }

  ctx.write(':');
  return parseValue(ctx, 'object-value', true);
}

/** Writes the object key at the cursor, quoting it if the input did not. */
function parseKey(ctx: RepairContext): void {
  const { scanner } = ctx;
  const { source, end } = scanner;
  const start = scanner.index;
  const code = scanner.peek();

  if (isQuote(code)) {
    readString(ctx, 'object-key');
    return;
  }

  let index = start;
  if (isIdentifierStart(code)) {
    index += 1;
    while (index < end && isIdentifierPart(source.charCodeAt(index))) {
      index += 1;
    }
  } else {
    // Aggressive mode only: take everything up to the colon and trim it.
    index = scanBareKey(ctx, start);
  }

  writeQuotedSpan(ctx, start, index);
  ctx.record('quoted-key', start);
  scanner.index = index;
}

/** Reports whether `code` can begin an object key under the active options. */
function canStartKey(ctx: RepairContext, code: number): boolean {
  if (isQuote(code)) {
    return code === CH_DOUBLE_QUOTE || ctx.options.allowSingleQuotes;
  }
  if (!ctx.options.allowUnquotedKeys) {
    return false;
  }
  if (isIdentifierStart(code)) {
    return true;
  }
  return ctx.options.aggressive && !isStructural(code);
}

/* ── Arrays ─────────────────────────────────────────────────────────────── */

function parseArray(ctx: RepairContext, mayDrop: boolean): ParseStatus {
  const { scanner } = ctx;
  const openPosition = scanner.index;
  const entry = ctx.checkpoint(openPosition);

  scanner.index += 1;
  ctx.enter(openPosition);
  ctx.openBrackets += 1;
  ctx.write('[');

  let elements = 0;
  let closed = false;
  let truncated = false;
  let previousIndex = -1;

  for (;;) {
    skipTrivia(ctx);

    if (scanner.index === previousIndex) {
      ctx.fail('Parser made no progress', scanner.index);
    }
    previousIndex = scanner.index;

    const code = scanner.peek();

    if (code === CH_EOF) {
      closeUnterminated(ctx, 'array', scanner.index);
      truncated = true;
      break;
    }
    if (code === CH_CLOSE_BRACKET) {
      scanner.index += 1;
      closed = true;
      break;
    }
    if (code === CH_CLOSE_BRACE) {
      if (ctx.openBraces > 0) {
        closeUnterminated(ctx, 'array', scanner.index);
        break;
      }
      dropStrayCloser(ctx);
      continue;
    }
    if (code === CH_COMMA) {
      // An elided element. Unlike an extra comma between object members this
      // changes the array's length, so safe mode declines to guess.
      if (!ctx.options.aggressive) {
        ctx.refuse('Array element is missing', scanner.index);
      }
      if (elements > 0) {
        ctx.write(',');
      }
      ctx.write('null');
      ctx.record('added-missing-value', scanner.index);
      elements += 1;
      scanner.index += 1;
      continue;
    }

    const slot = ctx.checkpoint(scanner.index);
    if (elements > 0) {
      ctx.write(',');
    }

    if (parseValue(ctx, 'array-element', true) === 'dropped') {
      ctx.restore(slot);
      scanner.index = scanner.end;
      ctx.record('removed-incomplete-member', slot.index);
      closeUnterminated(ctx, 'array', slot.index);
      truncated = true;
      break;
    }

    elements += 1;
    readSeparator(ctx);
  }

  ctx.write(']');
  ctx.openBrackets -= 1;
  ctx.leave();

  if (mayDrop && truncated && !closed && elements === 0) {
    ctx.restore(entry);
    scanner.index = scanner.end;
    return 'dropped';
  }
  return 'ok';
}

/* ── Bare tokens ────────────────────────────────────────────────────────── */

/** Emits an unquoted token as a literal, a number, or — aggressively — a string. */
function parseBareValue(ctx: RepairContext, start: number, coreEnd: number): ParseStatus {
  const { scanner } = ctx;

  const literal = readLiteral(ctx, start, coreEnd);
  if (literal === 'emitted') {
    scanner.index = coreEnd;
    return 'ok';
  }
  if (literal === 'needs-aggressive') {
    ctx.refuse(`"${scanner.slice(start, coreEnd)}" is not a JSON literal`, start);
  }

  if (readNumber(ctx, start, coreEnd)) {
    scanner.index = coreEnd;
    return 'ok';
  }

  if (!ctx.options.aggressive) {
    ctx.refuse(`Unquoted value "${scanner.slice(start, coreEnd)}"`, start);
  }

  const valueEnd = extendBareValue(ctx, coreEnd);
  writeQuotedSpan(ctx, start, valueEnd);
  ctx.record('quoted-value', start);
  scanner.index = valueEnd;
  return 'ok';
}

/**
 * Scans an unquoted token: everything up to whitespace, a structural character,
 * a quote or the start of a comment.
 */
function scanCoreToken(ctx: RepairContext, from: number): number {
  const { source, end } = ctx.scanner;
  const allowComments = ctx.options.allowComments;

  let index = from;
  while (index < end) {
    const code = source.charCodeAt(index);
    if (
      isWhitespace(code) ||
      isStructural(code) ||
      isQuote(code) ||
      startsComment(source, index, end, allowComments)
    ) {
      break;
    }
    index += 1;
  }
  return index;
}

/**
 * Extends an unquoted value across interior whitespace, so `{a: hello world}`
 * yields one value rather than two.
 *
 * Trailing whitespace is excluded, and the scan still stops at any structural
 * character, which keeps `[1 2]` two elements with a missing comma between them.
 */
function extendBareValue(ctx: RepairContext, from: number): number {
  const { source, end } = ctx.scanner;
  const allowComments = ctx.options.allowComments;

  let index = from;
  let lastContent = from;
  while (index < end) {
    const code = source.charCodeAt(index);
    if (isStructural(code) || startsComment(source, index, end, allowComments)) {
      break;
    }
    if (!isWhitespace(code)) {
      lastContent = index + 1;
    }
    index += 1;
  }
  return lastContent;
}

/** Scans an unquoted key: everything up to the colon, trimmed. */
function scanBareKey(ctx: RepairContext, from: number): number {
  const { source, end } = ctx.scanner;
  const allowComments = ctx.options.allowComments;

  let index = from;
  let lastContent = from + 1;
  while (index < end) {
    const code = source.charCodeAt(index);
    if (
      code === CH_COLON ||
      isStructural(code) ||
      startsComment(source, index, end, allowComments)
    ) {
      break;
    }
    if (!isWhitespace(code)) {
      lastContent = index + 1;
    }
    index += 1;
  }
  return lastContent;
}

function startsComment(
  source: string,
  index: number,
  end: number,
  allowComments: boolean,
): boolean {
  if (!allowComments) {
    return false;
  }
  const code = source.charCodeAt(index);
  if (code === CH_HASH) {
    return true;
  }
  if (code !== CH_SLASH || index + 1 >= end) {
    return false;
  }
  const next = source.charCodeAt(index + 1);
  return next === CH_SLASH || next === CH_ASTERISK;
}

/** Renders one character for an error message. */
function describeChar(source: string, index: number): string {
  const code = source.charCodeAt(index);
  if (Number.isNaN(code)) {
    return 'end of input';
  }
  if (code < 0x20 || code === 0x7f) {
    return `"\\u${code.toString(16).padStart(4, '0')}"`;
  }
  return `"${source.charAt(index)}"`;
}
