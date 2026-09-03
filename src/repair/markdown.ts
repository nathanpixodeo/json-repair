import {
  CH_BACKTICK,
  CH_LINE_FEED,
  CH_OPEN_BRACE,
  CH_OPEN_BRACKET,
  CH_SPACE,
  CH_TAB,
  isLineBreak,
  isWhitespace,
  toLowerAscii,
} from '../scanner/tokens.js';

/** Tilde, the alternative Markdown fence character. */
const CH_TILDE = 0x7e;

/** Shortest run of `` ` `` or `~` that opens a fenced block. */
const MIN_FENCE_LENGTH = 3;

/** Deepest indentation a fence may carry and still open a block. */
const MAX_FENCE_INDENT = 3;

/** A fenced code block found in the input. */
export interface Fence {
  /** First offset of the block's content. */
  bodyStart: number;
  /** Offset one past the block's content. */
  bodyEnd: number;
  /** Whether the info string names a JSON dialect. */
  jsonTagged: boolean;
}

/**
 * Finds Markdown fenced code blocks, in document order.
 *
 * Written as a linear character scan rather than a pattern match. A regular
 * expression over untrusted, unbounded text is exactly the shape that
 * backtracks catastrophically, and the whole package is built to stay linear on
 * hostile input.
 *
 * A block that is never closed — the usual result of a response hitting its
 * token limit — runs to the end of the input, which is what makes truncated
 * fenced output recoverable.
 */
export function scanFences(source: string, start: number, end: number): Fence[] {
  const fences: Fence[] = [];

  let lineStart = start;
  while (lineStart < end) {
    const lineEnd = findLineEnd(source, lineStart, end);
    const marker = readFenceMarker(source, lineStart, lineEnd);

    if (marker === undefined) {
      lineStart = nextLineStart(source, lineEnd, end);
      continue;
    }

    const bodyStart = nextLineStart(source, lineEnd, end);
    const closing = findClosingFence(source, bodyStart, end, marker.char, marker.length);

    fences.push({
      bodyStart,
      bodyEnd: closing.bodyEnd,
      jsonTagged: isJsonInfoString(source, marker.infoStart, lineEnd),
    });

    lineStart = closing.next;
  }

  return fences;
}

/**
 * Collects the offsets of every `{` and `[` in a region, in document order.
 *
 * These are only *candidate* starts. Nothing here tries to decide where a value
 * ends or whether a brace sits inside a string — that is the parser's job, and
 * duplicating it with a second, weaker notion of "string" is how extraction
 * silently truncates values such as `{'note': 'use } to close', 'n': 2}`.
 */
export function findValueStarts(
  source: string,
  start: number,
  end: number,
  limit: number,
): number[] {
  const starts: number[] = [];

  for (let index = start; index < end && starts.length < limit; index += 1) {
    const code = source.charCodeAt(index);
    if (code === CH_OPEN_BRACE || code === CH_OPEN_BRACKET) {
      starts.push(index);
    }
  }

  return starts;
}

/** Returns the first non-whitespace offset at or after `start`, or `end`. */
export function skipLeadingWhitespace(source: string, start: number, end: number): number {
  let index = start;
  while (index < end && isWhitespace(source.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

/** Returns the offset one past the last non-whitespace character before `end`. */
export function trimTrailingWhitespace(source: string, start: number, end: number): number {
  let index = end;
  while (index > start && isWhitespace(source.charCodeAt(index - 1))) {
    index -= 1;
  }
  return index;
}

interface FenceMarker {
  char: number;
  length: number;
  infoStart: number;
}

/** Reads an opening fence marker from a line, if the line is one. */
function readFenceMarker(
  source: string,
  lineStart: number,
  lineEnd: number,
): FenceMarker | undefined {
  let index = lineStart;
  let indent = 0;
  while (index < lineEnd && indent <= MAX_FENCE_INDENT) {
    const code = source.charCodeAt(index);
    if (code !== CH_SPACE && code !== CH_TAB) {
      break;
    }
    indent += 1;
    index += 1;
  }

  if (index >= lineEnd || indent > MAX_FENCE_INDENT) {
    return undefined;
  }

  const char = source.charCodeAt(index);
  if (char !== CH_BACKTICK && char !== CH_TILDE) {
    return undefined;
  }

  const runStart = index;
  while (index < lineEnd && source.charCodeAt(index) === char) {
    index += 1;
  }

  const length = index - runStart;
  return length >= MIN_FENCE_LENGTH ? { char, length, infoStart: index } : undefined;
}

/** Locates the fence that closes a block, or the end of the input. */
function findClosingFence(
  source: string,
  bodyStart: number,
  end: number,
  char: number,
  length: number,
): { bodyEnd: number; next: number } {
  let lineStart = bodyStart;

  while (lineStart < end) {
    const lineEnd = findLineEnd(source, lineStart, end);
    const marker = readFenceMarker(source, lineStart, lineEnd);

    if (marker?.char === char && marker.length >= length) {
      return { bodyEnd: lineStart, next: nextLineStart(source, lineEnd, end) };
    }

    lineStart = nextLineStart(source, lineEnd, end);
  }

  return { bodyEnd: end, next: end };
}

/** Reports whether a fence's info string names a JSON dialect. */
function isJsonInfoString(source: string, from: number, lineEnd: number): boolean {
  let index = from;
  while (index < lineEnd && isWhitespace(source.charCodeAt(index))) {
    index += 1;
  }

  const wordStart = index;
  while (index < lineEnd) {
    const code = toLowerAscii(source.charCodeAt(index));
    if (code < 0x30 || (code > 0x39 && code < 0x61) || code > 0x7a) {
      break;
    }
    index += 1;
  }

  const length = index - wordStart;
  if (length < 4 || length > 5) {
    return false;
  }
  if (
    toLowerAscii(source.charCodeAt(wordStart)) !== 0x6a /* j */ ||
    toLowerAscii(source.charCodeAt(wordStart + 1)) !== 0x73 /* s */ ||
    toLowerAscii(source.charCodeAt(wordStart + 2)) !== 0x6f /* o */ ||
    toLowerAscii(source.charCodeAt(wordStart + 3)) !== 0x6e /* n */
  ) {
    return false;
  }
  if (length === 4) {
    return true;
  }
  const suffix = toLowerAscii(source.charCodeAt(wordStart + 4));
  return suffix === 0x63 /* jsonc */ || suffix === 0x35; /* json5 */
}

/** Returns the offset of the line break that ends the line starting at `from`. */
function findLineEnd(source: string, from: number, end: number): number {
  let index = from;
  while (index < end && !isLineBreak(source.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

/** Returns the offset at which the line after `lineEnd` begins. */
function nextLineStart(source: string, lineEnd: number, end: number): number {
  if (lineEnd >= end) {
    return end;
  }
  let index = lineEnd + 1;
  if (
    source.charCodeAt(lineEnd) !== CH_LINE_FEED &&
    index < end &&
    source.charCodeAt(index) === CH_LINE_FEED
  ) {
    index += 1;
  }
  return index;
}
