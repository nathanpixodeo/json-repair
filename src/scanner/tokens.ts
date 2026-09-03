/**
 * Character-code constants and predicates shared by the scanner, the parser and
 * the repair rules.
 *
 * Everything here works on UTF-16 code units via `charCodeAt`. The package uses
 * no regular expressions at all — a deliberate choice, since a repair engine
 * fed adversarial input is exactly where catastrophic backtracking bites. Every
 * predicate below is a constant-time comparison, which keeps the whole pipeline
 * linear in the length of the input.
 */

/* ── Structural characters ──────────────────────────────────────────────── */

export const CH_OPEN_BRACE = 0x7b; /* { */
export const CH_CLOSE_BRACE = 0x7d; /* } */
export const CH_OPEN_BRACKET = 0x5b; /* [ */
export const CH_CLOSE_BRACKET = 0x5d; /* ] */
export const CH_COLON = 0x3a; /* : */
export const CH_COMMA = 0x2c; /* , */

/* ── Quotes ─────────────────────────────────────────────────────────────── */

export const CH_DOUBLE_QUOTE = 0x22; /* " */
export const CH_SINGLE_QUOTE = 0x27; /* ' */
export const CH_BACKTICK = 0x60; /* ` */
export const CH_LEFT_SINGLE_QUOTE = 0x2018; /* ‘ */
export const CH_RIGHT_SINGLE_QUOTE = 0x2019; /* ’ */
export const CH_SINGLE_LOW_QUOTE = 0x201a; /* ‚ */
export const CH_SINGLE_HIGH_REVERSED = 0x201b; /* ‛ */
export const CH_LEFT_DOUBLE_QUOTE = 0x201c; /* “ */
export const CH_RIGHT_DOUBLE_QUOTE = 0x201d; /* ” */
export const CH_DOUBLE_LOW_QUOTE = 0x201e; /* „ */
export const CH_DOUBLE_HIGH_REVERSED = 0x201f; /* ‟ */

/* ── Escapes, comments, signs ───────────────────────────────────────────── */

export const CH_BACKSLASH = 0x5c; /* \ */
export const CH_SLASH = 0x2f; /* / */
export const CH_ASTERISK = 0x2a; /* * */
export const CH_HASH = 0x23; /* # */
export const CH_MINUS = 0x2d; /* - */
export const CH_PLUS = 0x2b; /* + */
export const CH_DOT = 0x2e; /* . */
export const CH_UNDERSCORE = 0x5f; /* _ */
export const CH_DOLLAR = 0x24; /* $ */

/* ── Whitespace and line breaks ─────────────────────────────────────────── */

export const CH_TAB = 0x09;
export const CH_LINE_FEED = 0x0a;
export const CH_VERTICAL_TAB = 0x0b;
export const CH_FORM_FEED = 0x0c;
export const CH_CARRIAGE_RETURN = 0x0d;
export const CH_SPACE = 0x20;
export const CH_NBSP = 0x00a0;
export const CH_BOM = 0xfeff;

/* ── Letters used by literal and escape handling ────────────────────────── */

export const CH_LOWER_A = 0x61;
export const CH_LOWER_B = 0x62;
export const CH_LOWER_E = 0x65;
export const CH_LOWER_F = 0x66;
export const CH_LOWER_N = 0x6e;
export const CH_LOWER_R = 0x72;
export const CH_LOWER_T = 0x74;
export const CH_LOWER_U = 0x75;
export const CH_LOWER_X = 0x78;
export const CH_LOWER_Z = 0x7a;
export const CH_UPPER_A = 0x41;
export const CH_UPPER_E = 0x45;
export const CH_UPPER_F = 0x46;
export const CH_UPPER_X = 0x58;
export const CH_UPPER_Z = 0x5a;
export const CH_ZERO = 0x30;
export const CH_NINE = 0x39;

/* ── Surrogates ─────────────────────────────────────────────────────────── */

export const CH_HIGH_SURROGATE_START = 0xd800;
export const CH_HIGH_SURROGATE_END = 0xdbff;
export const CH_LOW_SURROGATE_START = 0xdc00;
export const CH_LOW_SURROGATE_END = 0xdfff;

/** Sentinel returned by the scanner past the end of its bounded region. */
export const CH_EOF = -1;

/* ── Predicates ─────────────────────────────────────────────────────────── */

/**
 * Whitespace recognised *between* tokens.
 *
 * Wider than the four characters JSON allows, because malformed input pasted
 * from a browser, a PDF or a word processor routinely carries non-breaking
 * spaces and Unicode separators. They are treated as trivia and dropped, never
 * as data — inside a string literal these characters remain untouched content.
 */
export function isWhitespace(code: number): boolean {
  switch (code) {
    case CH_SPACE:
    case CH_TAB:
    case CH_LINE_FEED:
    case CH_CARRIAGE_RETURN:
    case CH_VERTICAL_TAB:
    case CH_FORM_FEED:
    case CH_NBSP:
    case CH_BOM:
    case 0x1680: /* OGHAM SPACE MARK */
    case 0x2028: /* LINE SEPARATOR */
    case 0x2029: /* PARAGRAPH SEPARATOR */
    case 0x202f: /* NARROW NO-BREAK SPACE */
    case 0x205f: /* MEDIUM MATHEMATICAL SPACE */
    case 0x3000 /* IDEOGRAPHIC SPACE */:
      return true;
    default:
      // U+2000..U+200A: EN QUAD through HAIR SPACE.
      return code >= 0x2000 && code <= 0x200a;
  }
}

/**
 * The four characters JSON itself allows between tokens.
 *
 * Anything {@link isWhitespace} accepts beyond these is a repair, not trivia, so
 * skipping it has to be recorded in the repair log.
 */
export function isJsonWhitespace(code: number): boolean {
  return (
    code === CH_SPACE || code === CH_TAB || code === CH_LINE_FEED || code === CH_CARRIAGE_RETURN
  );
}

/** Reports whether `code` ends a line for the purpose of line/column reporting. */
export function isLineBreak(code: number): boolean {
  return code === CH_LINE_FEED || code === CH_CARRIAGE_RETURN;
}

/** Reports whether `code` is an ASCII decimal digit. */
export function isDigit(code: number): boolean {
  return code >= CH_ZERO && code <= CH_NINE;
}

/** Reports whether `code` is a hexadecimal digit in either case. */
export function isHexDigit(code: number): boolean {
  return (
    (code >= CH_ZERO && code <= CH_NINE) ||
    (code >= CH_UPPER_A && code <= CH_UPPER_F) ||
    (code >= CH_LOWER_A && code <= CH_LOWER_F)
  );
}

/**
 * Reports whether `code` opens a string literal in some dialect.
 *
 * Covers the JSON `"`, the JavaScript `'` and `` ` ``, and the typographic
 * quotes U+2018..U+201F that word processors and LLM prose substitute. The
 * table is deliberately closed: guillemets (`«` `»`) and CJK brackets are *not*
 * included, because they appear far more often as ordinary prose punctuation
 * than as string delimiters.
 */
export function isQuote(code: number): boolean {
  switch (code) {
    case CH_DOUBLE_QUOTE:
    case CH_SINGLE_QUOTE:
    case CH_BACKTICK:
    case CH_LEFT_SINGLE_QUOTE:
    case CH_RIGHT_SINGLE_QUOTE:
    case CH_SINGLE_LOW_QUOTE:
    case CH_SINGLE_HIGH_REVERSED:
    case CH_LEFT_DOUBLE_QUOTE:
    case CH_RIGHT_DOUBLE_QUOTE:
    case CH_DOUBLE_LOW_QUOTE:
    case CH_DOUBLE_HIGH_REVERSED:
      return true;
    default:
      return false;
  }
}

/**
 * Returns the set of code units that can close a string opened by `code`.
 *
 * Typographic quotes are paired, so a string opened with `“` closes on `”` —
 * but LLM output mixes them freely, so the opening character is accepted as a
 * closer too. Returns `-1` for the second slot when there is only one closer.
 */
export function closersFor(code: number): readonly [number, number] {
  switch (code) {
    case CH_LEFT_DOUBLE_QUOTE:
    case CH_DOUBLE_LOW_QUOTE:
    case CH_DOUBLE_HIGH_REVERSED:
      return [CH_RIGHT_DOUBLE_QUOTE, code];
    case CH_RIGHT_DOUBLE_QUOTE:
      return [CH_RIGHT_DOUBLE_QUOTE, CH_LEFT_DOUBLE_QUOTE];
    case CH_LEFT_SINGLE_QUOTE:
    case CH_SINGLE_LOW_QUOTE:
    case CH_SINGLE_HIGH_REVERSED:
      return [CH_RIGHT_SINGLE_QUOTE, code];
    case CH_RIGHT_SINGLE_QUOTE:
      return [CH_RIGHT_SINGLE_QUOTE, CH_LEFT_SINGLE_QUOTE];
    default:
      return [code, -1];
  }
}

/**
 * Reports whether a string opened by `code` follows JSON escaping rules.
 *
 * Only `"` does. Inside `'`, `` ` `` or typographic quotes an apostrophe is far
 * more likely to be prose than a delimiter, which is why the continuation probe
 * treats those delimiters more permissively.
 */
export function isStandardQuote(code: number): boolean {
  return code === CH_DOUBLE_QUOTE;
}

/**
 * Reports whether `code` may start a bare (unquoted) object key or literal.
 *
 * Matches the JavaScript identifier convention restricted to ASCII letters plus
 * `_` and `$`, and additionally admits any code unit at or above U+00C0 so that
 * non-English keys (`{café: 1}`, `{名前: 1}`) are recognised. Digits are handled
 * by {@link isIdentifierPart} only, so `{2fast: 1}` is not mistaken for a key.
 */
export function isIdentifierStart(code: number): boolean {
  return (
    (code >= CH_LOWER_A && code <= CH_LOWER_Z) ||
    (code >= CH_UPPER_A && code <= CH_UPPER_Z) ||
    code === CH_UNDERSCORE ||
    code === CH_DOLLAR ||
    code >= 0x00c0
  );
}

/** Reports whether `code` may continue a bare object key or literal. */
export function isIdentifierPart(code: number): boolean {
  return isIdentifierStart(code) || isDigit(code) || code === CH_MINUS || code === CH_DOT;
}

/**
 * Reports whether `code` terminates an unquoted value in aggressive mode.
 *
 * Bare values run until a structural character, so `{a: hello world}` yields the
 * single value `"hello world"` rather than two tokens.
 */
export function isStructural(code: number): boolean {
  switch (code) {
    case CH_OPEN_BRACE:
    case CH_CLOSE_BRACE:
    case CH_OPEN_BRACKET:
    case CH_CLOSE_BRACKET:
    case CH_COLON:
    case CH_COMMA:
    case CH_EOF:
      return true;
    default:
      return false;
  }
}

/** Reports whether `code` is the high half of a surrogate pair. */
export function isHighSurrogate(code: number): boolean {
  return code >= CH_HIGH_SURROGATE_START && code <= CH_HIGH_SURROGATE_END;
}

/** Reports whether `code` is the low half of a surrogate pair. */
export function isLowSurrogate(code: number): boolean {
  return code >= CH_LOW_SURROGATE_START && code <= CH_LOW_SURROGATE_END;
}

/**
 * Lower-cases an ASCII letter code unit; returns other codes unchanged.
 *
 * Used for case-insensitive literal matching (`TRUE`, `Null`) without building
 * substrings or touching locale-sensitive `toLowerCase`, which would break the
 * determinism requirement under a Turkish locale.
 */
export function toLowerAscii(code: number): number {
  return code >= CH_UPPER_A && code <= CH_UPPER_Z ? code + 0x20 : code;
}
