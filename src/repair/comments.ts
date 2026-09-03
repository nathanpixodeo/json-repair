import type { RepairContext } from '../parser/state.js';
import {
  CH_ASTERISK,
  CH_HASH,
  CH_SLASH,
  isJsonWhitespace,
  isLineBreak,
  isWhitespace,
} from '../scanner/tokens.js';

/**
 * Advances past whitespace and comments, recording each comment removed.
 *
 * Three comment syntaxes are accepted, all controlled by
 * `RepairOptions.allowComments`: `//` and `#` run to the end of the line, while
 * a C-style block comment runs to its terminator or, if it was never closed, to
 * the end of the input. Comments are trivia, so removing one never merges the tokens
 * around it — the parser reads the tokens separately and inserts any separator
 * that turns out to be missing.
 */
export function skipTrivia(ctx: RepairContext): void {
  const { scanner } = ctx;
  const { source, end } = scanner;
  const allowComments = ctx.options.allowComments;

  let index = scanner.index;

  for (;;) {
    // One record per run of whitespace, not per character, so a paste full of
    // non-breaking spaces cannot inflate the repair log out of proportion.
    let exotic = -1;
    while (index < end) {
      const code = source.charCodeAt(index);
      if (!isWhitespace(code)) {
        break;
      }
      if (exotic < 0 && !isJsonWhitespace(code)) {
        exotic = index;
      }
      index += 1;
    }

    if (exotic >= 0) {
      scanner.index = index;
      ctx.record('normalized-whitespace', exotic);
    }

    if (index >= end || !allowComments) {
      break;
    }

    const commentStart = index;
    const code = source.charCodeAt(index);

    if (code === CH_HASH) {
      index = skipToLineEnd(source, index + 1, end);
    } else if (code === CH_SLASH && index + 1 < end) {
      const nextCode = source.charCodeAt(index + 1);
      if (nextCode === CH_SLASH) {
        index = skipToLineEnd(source, index + 2, end);
      } else if (nextCode === CH_ASTERISK) {
        index = skipBlockComment(source, index + 2, end);
      } else {
        break;
      }
    } else {
      break;
    }

    scanner.index = index;
    ctx.record('removed-comment', commentStart);
  }

  scanner.index = index;
}

/**
 * Returns the offset after the whitespace and comments starting at `from`,
 * without recording anything.
 *
 * Used by the string-continuation probe, which must look past trivia while
 * remaining free of side effects — it may decide the lookahead was wrong.
 */
export function scanTrivia(
  source: string,
  from: number,
  end: number,
  allowComments: boolean,
): number {
  let index = from;

  for (;;) {
    while (index < end && isWhitespace(source.charCodeAt(index))) {
      index += 1;
    }

    if (index >= end || !allowComments) {
      return index;
    }

    const code = source.charCodeAt(index);

    if (code === CH_HASH) {
      index = skipToLineEnd(source, index + 1, end);
    } else if (code === CH_SLASH && index + 1 < end) {
      const nextCode = source.charCodeAt(index + 1);
      if (nextCode === CH_SLASH) {
        index = skipToLineEnd(source, index + 2, end);
      } else if (nextCode === CH_ASTERISK) {
        index = skipBlockComment(source, index + 2, end);
      } else {
        return index;
      }
    } else {
      return index;
    }
  }
}

function skipToLineEnd(source: string, from: number, end: number): number {
  let index = from;
  while (index < end && !isLineBreak(source.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

function skipBlockComment(source: string, from: number, end: number): number {
  let index = from;
  while (index < end) {
    if (
      source.charCodeAt(index) === CH_ASTERISK &&
      index + 1 < end &&
      source.charCodeAt(index + 1) === CH_SLASH
    ) {
      return index + 2;
    }
    index += 1;
  }
  // Unterminated block comment: everything to the end of the input is comment.
  return end;
}
