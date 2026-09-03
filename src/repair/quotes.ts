import { probeContinuation, type Slot } from '../parser/probe.js';
import type { Checkpoint, RepairContext } from '../parser/state.js';
import {
  CH_BACKSLASH,
  CH_CARRIAGE_RETURN,
  CH_CLOSE_BRACE,
  CH_CLOSE_BRACKET,
  CH_COMMA,
  CH_DOUBLE_QUOTE,
  CH_LINE_FEED,
  CH_LOWER_B,
  CH_LOWER_F,
  CH_LOWER_N,
  CH_LOWER_R,
  CH_LOWER_T,
  CH_LOWER_U,
  CH_SLASH,
  closersFor,
  isHexDigit,
  isHighSurrogate,
  isLowSurrogate,
  isQuote,
  isStandardQuote,
  isWhitespace,
} from '../scanner/tokens.js';

/* Classification of the escape sequence at a backslash. Non-negative values are
 * the length of a sequence JSON already accepts verbatim. */
const ESC_SHORT = 2;
const ESC_UNICODE = 6;
const ESC_DANGLING = -1; /* backslash is the last character of the input */
const ESC_TRUNCATED_UNICODE = -2; /* `\u` with too few hex digits before the end */
const ESC_BAD_UNICODE = -3; /* `\u` not followed by four hex digits */
const ESC_QUOTE = -4; /* backslash before a quote character */
const ESC_CONTROL = -5; /* backslash before a raw control character */
const ESC_UNKNOWN = -6; /* backslash before anything else */

/**
 * Reads a quoted string and writes it back as a canonical JSON string.
 *
 * Handles every string-level repair in one pass:
 *
 * - non-standard delimiters (`'`, `` ` ``, `“ ”`) become `"`,
 * - raw control characters and unpaired surrogates are escaped,
 * - invalid escape sequences are corrected without losing characters,
 * - a quote that does not actually end the string becomes escaped content,
 * - a string left open is closed, at a line break or at end of input.
 *
 * The cursor must sit on the opening quote, and is left just past the point the
 * string was found to end.
 */
export function readString(ctx: RepairContext, slot: Slot): void {
  const { scanner } = ctx;
  const { source, end } = scanner;

  const start = scanner.index;
  const opener = source.charCodeAt(start);
  const standard = isStandardQuote(opener);
  const closers = closersFor(opener);
  const closerA = closers[0];
  const closerB = closers[1];

  if (!standard) {
    ctx.record('normalized-quotes', start);
  }

  ctx.write('"');

  let index = start + 1;
  let spanStart = index;
  let checkpoint: Checkpoint | undefined;
  /** End of the last reported run of control characters, so a multi-line string logs one repair per line, not per character. */
  let reportedControlEnd = -1;

  while (index < end) {
    const code = source.charCodeAt(index);

    if (code === CH_BACKSLASH) {
      const kind = classifyEscape(source, index, end);
      if (kind >= 0) {
        index += kind;
        continue;
      }

      ctx.writeSpan(spanStart, index);

      switch (kind) {
        case ESC_DANGLING:
          ctx.record('fixed-escape', index, 'Removed a trailing backslash with nothing to escape');
          index = end;
          break;
        case ESC_TRUNCATED_UNICODE:
          ctx.record('fixed-escape', index, 'Removed a truncated \\u escape at end of input');
          index = end;
          break;
        case ESC_BAD_UNICODE:
          ctx.write('\\\\u');
          ctx.record('fixed-escape', index, 'Escaped an incomplete \\u sequence');
          index += 2;
          break;
        case ESC_QUOTE: {
          // `'it\'s'` and friends: the backslash belonged to the source dialect.
          const quoted = source.charCodeAt(index + 1);
          ctx.write(quoted === CH_DOUBLE_QUOTE ? '\\"' : source[index + 1]!);
          ctx.record('fixed-escape', index, 'Unescaped a quote that JSON does not escape');
          index += 2;
          break;
        }
        case ESC_CONTROL:
          ctx.write(escapeControl(source.charCodeAt(index + 1)));
          ctx.record('fixed-escape', index, 'Replaced a backslash before a control character');
          index += 2;
          break;
        default:
          // Keep both characters: `\x41` stays `\x41` rather than becoming `x41`.
          ctx.write('\\\\');
          ctx.write(source[index + 1]!);
          ctx.record('fixed-escape', index, 'Escaped a backslash that began an unknown sequence');
          index += 2;
          break;
      }

      spanStart = index;
      continue;
    }

    if (code === closerA || code === closerB) {
      if (probeContinuation(ctx, index + 1, slot)) {
        ctx.writeSpan(spanStart, index);
        ctx.write('"');
        scanner.index = index + 1;
        return;
      }

      // Nothing that could continue the container follows this quote. Either the
      // quote is content, or — in safe mode with a standard delimiter — the real
      // closing quote was dropped and the string ended at the previous newline.
      if (standard && !ctx.options.aggressive) {
        if (checkpoint !== undefined && ctx.canRewindTo(checkpoint)) {
          closeAtCheckpoint(ctx, checkpoint);
          return;
        }
        ctx.writeSpan(spanStart, index);
        ctx.write('"');
        scanner.index = index + 1;
        return;
      }

      ctx.writeSpan(spanStart, index);
      if (standard) {
        ctx.write('\\"');
        ctx.record('escaped-character', index, 'Escaped a quote inside a string');
      } else {
        ctx.write(source[index]!);
      }
      index += 1;
      spanStart = index;
      continue;
    }

    if (code < 0x20) {
      ctx.writeSpan(spanStart, index);
      if (code === CH_LINE_FEED || code === CH_CARRIAGE_RETURN) {
        // Remember where the line ended: if the closing quote turns out to be
        // missing, this is the most likely place for the string to have stopped.
        checkpoint = ctx.checkpoint(index);
      }
      if (index !== reportedControlEnd) {
        ctx.record('escaped-character', index, 'Escaped a raw control character in a string');
      }
      reportedControlEnd = index + 1;
      ctx.write(escapeControl(code));
      index += 1;
      spanStart = index;
      continue;
    }

    if (code === CH_DOUBLE_QUOTE) {
      // Reached only inside a non-standard delimiter, where `"` is plain content.
      ctx.writeSpan(spanStart, index);
      ctx.write('\\"');
      index += 1;
      spanStart = index;
      continue;
    }

    if (isHighSurrogate(code)) {
      if (index + 1 < end && isLowSurrogate(source.charCodeAt(index + 1))) {
        index += 2;
        continue;
      }
      index = escapeStrayUnit(ctx, spanStart, index, code);
      spanStart = index;
      continue;
    }

    if (isLowSurrogate(code)) {
      index = escapeStrayUnit(ctx, spanStart, index, code);
      spanStart = index;
      continue;
    }

    index += 1;
  }

  // End of input reached with the string still open.
  ctx.writeSpan(spanStart, index);

  if (
    checkpoint !== undefined &&
    ctx.canRewindTo(checkpoint) &&
    tailIsStructural(source, checkpoint.index, end)
  ) {
    closeAtCheckpoint(ctx, checkpoint);
    return;
  }

  ctx.write('"');
  ctx.record('terminated-string-at-eof', end);
  scanner.index = end;
}

/**
 * Writes `[from, to)` of the input as a JSON string literal.
 *
 * Used for text that was never quoted in the source — a bare key or, in
 * aggressive mode, a bare value. Unescaped runs are copied as spans, so the
 * cost is proportional to the number of characters that actually need escaping.
 */
export function writeQuotedSpan(ctx: RepairContext, from: number, to: number): void {
  const { source } = ctx.scanner;

  ctx.write('"');

  let spanStart = from;
  for (let index = from; index < to; index += 1) {
    const code = source.charCodeAt(index);

    let replacement: string | undefined;
    if (code === CH_DOUBLE_QUOTE) {
      replacement = '\\"';
    } else if (code === CH_BACKSLASH) {
      replacement = '\\\\';
    } else if (code < 0x20) {
      replacement = escapeControl(code);
    } else if (isHighSurrogate(code)) {
      if (index + 1 < to && isLowSurrogate(source.charCodeAt(index + 1))) {
        index += 1;
        continue;
      }
      replacement = escapeUnit(code);
    } else if (isLowSurrogate(code)) {
      replacement = escapeUnit(code);
    }

    if (replacement !== undefined) {
      ctx.writeSpan(spanStart, index);
      ctx.write(replacement);
      spanStart = index + 1;
    }
  }

  ctx.writeSpan(spanStart, to);
  ctx.write('"');
}

/**
 * Escapes an unpaired surrogate so the output survives UTF-8 encoding.
 *
 * `JSON.parse` accepts a lone surrogate, but writing one to a file or a socket
 * produces a replacement character, so the repaired text would no longer round
 * trip. Escaping keeps the exact code unit. Input that needs no repair skips
 * this path entirely and is returned byte-identical.
 */
function escapeStrayUnit(
  ctx: RepairContext,
  spanStart: number,
  index: number,
  code: number,
): number {
  ctx.writeSpan(spanStart, index);
  ctx.write(escapeUnit(code));
  ctx.record('escaped-character', index, 'Escaped an unpaired surrogate');
  return index + 1;
}

/** Closes the string at a remembered line break and resumes parsing there. */
function closeAtCheckpoint(ctx: RepairContext, checkpoint: Checkpoint): void {
  ctx.rewindTo(checkpoint);
  ctx.write('"');
  ctx.record('terminated-string-at-newline', checkpoint.index);
}

/**
 * Classifies the escape sequence at `index`.
 *
 * Returns the length of the sequence when JSON already accepts it verbatim, so
 * the caller can keep extending its current span, or one of the `ESC_*` codes
 * when the sequence has to be rewritten.
 */
function classifyEscape(source: string, index: number, end: number): number {
  if (index + 1 >= end) {
    return ESC_DANGLING;
  }

  const escaped = source.charCodeAt(index + 1);

  switch (escaped) {
    case CH_DOUBLE_QUOTE:
    case CH_BACKSLASH:
    case CH_SLASH:
    case CH_LOWER_B:
    case CH_LOWER_F:
    case CH_LOWER_N:
    case CH_LOWER_R:
    case CH_LOWER_T:
      return ESC_SHORT;
    case CH_LOWER_U:
      if (
        index + 5 < end &&
        isHexDigit(source.charCodeAt(index + 2)) &&
        isHexDigit(source.charCodeAt(index + 3)) &&
        isHexDigit(source.charCodeAt(index + 4)) &&
        isHexDigit(source.charCodeAt(index + 5))
      ) {
        return ESC_UNICODE;
      }
      return index + 6 > end ? ESC_TRUNCATED_UNICODE : ESC_BAD_UNICODE;
    default:
      break;
  }

  if (isQuote(escaped)) {
    return ESC_QUOTE;
  }
  return escaped < 0x20 ? ESC_CONTROL : ESC_UNKNOWN;
}

/**
 * Reports whether everything between `from` and `end` is structural.
 *
 * Decides what an unterminated string at end of input swallowed. If the rest is
 * only whitespace and closing punctuation it was the document's structure —
 * `{"a": "oops⏎}` means `{"a":"oops"}`, not a value containing a brace. If it
 * holds anything else it is real content, and closing at end of input keeps it.
 */
function tailIsStructural(source: string, from: number, end: number): boolean {
  for (let index = from; index < end; index += 1) {
    const code = source.charCodeAt(index);
    if (
      code === CH_CLOSE_BRACE ||
      code === CH_CLOSE_BRACKET ||
      code === CH_COMMA ||
      isWhitespace(code)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/** Returns the JSON escape for a control character. */
function escapeControl(code: number): string {
  switch (code) {
    case 0x08:
      return '\\b';
    case 0x09:
      return '\\t';
    case 0x0a:
      return '\\n';
    case 0x0c:
      return '\\f';
    case 0x0d:
      return '\\r';
    default:
      return escapeUnit(code);
  }
}

/** Returns the `\uXXXX` escape for a code unit. */
function escapeUnit(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}
