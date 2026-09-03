import type { RepairContext } from '../parser/state.js';
import {
  CH_DOT,
  CH_LOWER_E,
  CH_LOWER_X,
  CH_MINUS,
  CH_PLUS,
  CH_UNDERSCORE,
  CH_UPPER_E,
  CH_UPPER_X,
  CH_ZERO,
  isDigit,
  isHexDigit,
} from '../scanner/tokens.js';

/**
 * Tries to emit the token spanning `[start, end)` as a JSON number.
 *
 * Returns `false` when the token is not a number under the active mode, leaving
 * the output untouched so the caller can fall back to quoting it or refusing.
 *
 * Numbers are never round-tripped through `Number`: doing so would rewrite
 * `1.0` as `1`, turn `1e999` into `Infinity` and quietly lose precision beyond
 * 2^53. The token's own digits are reused verbatim, and repairs are limited to
 * the smallest edit that makes the JSON grammar accept them.
 */
export function readNumber(ctx: RepairContext, start: number, end: number): boolean {
  const { source } = ctx.scanner;

  if (isValidJsonNumber(source, start, end)) {
    ctx.writeSpan(start, end);
    return true;
  }

  const aggressive = ctx.options.aggressive;
  let index = start;
  let sign = '';
  let normalized = false;

  const first = source.charCodeAt(index);
  if (first === CH_PLUS) {
    // JSON has no unary plus, but `+1` has exactly one reading.
    index += 1;
    normalized = true;
  } else if (first === CH_MINUS) {
    sign = '-';
    index += 1;
  }

  if (aggressive && isHexPrefix(source, index, end)) {
    return readHex(ctx, start, index, end, sign);
  }

  let usedUnderscore = false;
  let integerDigits = '';
  while (index < end) {
    const code = source.charCodeAt(index);
    if (isDigit(code)) {
      integerDigits += source.charAt(index);
    } else if (code === CH_UNDERSCORE) {
      usedUnderscore = true;
    } else {
      break;
    }
    index += 1;
  }

  let fractionDigits = '';
  let sawDot = false;
  if (index < end && source.charCodeAt(index) === CH_DOT) {
    sawDot = true;
    index += 1;
    while (index < end) {
      const code = source.charCodeAt(index);
      if (isDigit(code)) {
        fractionDigits += source.charAt(index);
      } else if (code === CH_UNDERSCORE) {
        usedUnderscore = true;
      } else {
        break;
      }
      index += 1;
    }
  }

  let exponent = '';
  if (index < end) {
    const code = source.charCodeAt(index);
    if (code === CH_LOWER_E || code === CH_UPPER_E) {
      let cursor = index + 1;
      let exponentSign = '';
      if (cursor < end) {
        const signCode = source.charCodeAt(cursor);
        if (signCode === CH_PLUS || signCode === CH_MINUS) {
          exponentSign = signCode === CH_MINUS ? '-' : '';
          cursor += 1;
        }
      }
      const digitsStart = cursor;
      while (cursor < end && isDigit(source.charCodeAt(cursor))) {
        cursor += 1;
      }
      if (cursor > digitsStart) {
        exponent = `e${exponentSign}${source.slice(digitsStart, cursor)}`;
      } else {
        // `1e` and `1e+` carry no exponent; dropping it is the only reading.
        normalized = true;
      }
      index = cursor;
    }
  }

  // Anything left over means this was never a number: `1.2.3`, `12abc`, `--1`.
  if (index !== end || (integerDigits.length === 0 && fractionDigits.length === 0)) {
    return false;
  }

  if (usedUnderscore) {
    if (!aggressive) {
      return false;
    }
    normalized = true;
  }

  let integerPart = integerDigits;
  if (integerPart.length === 0) {
    // `.5` is unambiguous once the missing zero is supplied.
    integerPart = '0';
    normalized = true;
  } else if (integerPart.length > 1 && integerPart.charCodeAt(0) === CH_ZERO) {
    // `007` could be a padded identifier, so only aggressive mode picks a reading.
    if (!aggressive) {
      return false;
    }
    let cut = 0;
    while (cut < integerPart.length - 1 && integerPart.charCodeAt(cut) === CH_ZERO) {
      cut += 1;
    }
    integerPart = integerPart.slice(cut);
    normalized = true;
  }

  if (sawDot && fractionDigits.length === 0) {
    // `5.` means `5`; JSON requires a digit after the point.
    normalized = true;
  }

  if (!normalized) {
    return false;
  }

  ctx.write(sign);
  ctx.write(integerPart);
  if (fractionDigits.length > 0) {
    ctx.write('.');
    ctx.write(fractionDigits);
  }
  ctx.write(exponent);
  ctx.record('normalized-number', start);
  return true;
}

/** Reports whether `[start, end)` already matches the JSON number grammar. */
export function isValidJsonNumber(source: string, start: number, end: number): boolean {
  let index = start;
  if (index < end && source.charCodeAt(index) === CH_MINUS) {
    index += 1;
  }

  if (index >= end) {
    return false;
  }

  if (source.charCodeAt(index) === CH_ZERO) {
    index += 1;
  } else {
    if (!isDigit(source.charCodeAt(index))) {
      return false;
    }
    while (index < end && isDigit(source.charCodeAt(index))) {
      index += 1;
    }
  }

  if (index < end && source.charCodeAt(index) === CH_DOT) {
    index += 1;
    const digitsStart = index;
    while (index < end && isDigit(source.charCodeAt(index))) {
      index += 1;
    }
    if (index === digitsStart) {
      return false;
    }
  }

  if (index < end) {
    const code = source.charCodeAt(index);
    if (code !== CH_LOWER_E && code !== CH_UPPER_E) {
      return false;
    }
    index += 1;
    if (index < end) {
      const signCode = source.charCodeAt(index);
      if (signCode === CH_PLUS || signCode === CH_MINUS) {
        index += 1;
      }
    }
    const digitsStart = index;
    while (index < end && isDigit(source.charCodeAt(index))) {
      index += 1;
    }
    if (index === digitsStart) {
      return false;
    }
  }

  return index === end;
}

function isHexPrefix(source: string, index: number, end: number): boolean {
  if (index + 2 >= end || source.charCodeAt(index) !== CH_ZERO) {
    return false;
  }
  const marker = source.charCodeAt(index + 1);
  return marker === CH_LOWER_X || marker === CH_UPPER_X;
}

/**
 * Converts `0x…` to decimal.
 *
 * `BigInt` keeps values above 2^53 exact, which `parseInt` would not — a hex
 * hash rewritten as a lossy float would be a silent data corruption.
 */
function readHex(
  ctx: RepairContext,
  start: number,
  prefixStart: number,
  end: number,
  sign: string,
): boolean {
  const { source } = ctx.scanner;
  const digitsStart = prefixStart + 2;

  let index = digitsStart;
  while (index < end && isHexDigit(source.charCodeAt(index))) {
    index += 1;
  }
  if (index !== end || index === digitsStart) {
    return false;
  }

  const value = BigInt(source.slice(prefixStart, end));
  ctx.write(sign);
  ctx.write(value.toString());
  ctx.record('normalized-number', start);
  return true;
}
