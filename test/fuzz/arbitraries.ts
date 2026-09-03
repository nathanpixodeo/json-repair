/**
 * Shared fast-check arbitraries and helpers for the property-based fuzz suite.
 *
 * This module is intentionally not a `*.test.ts` file, so vitest never
 * collects it directly; it exists only to be imported by `properties.test.ts`
 * and `corruption.test.ts`.
 */
import fc from 'fast-check';

import type { RepairMode } from '../../src/index.js';

/** Bounded recursion depth used throughout the fuzz suite. */
export const MAX_VALUE_DEPTH = 5;

/**
 * Both repair modes, as `RepairMode` rather than `string`.
 *
 * A bare `fc.constantFrom('safe', 'aggressive')` widens to
 * `Arbitrary<string>`, which then fails to match the `mode` field of
 * `RepairOptions`; pinning the type argument keeps the literal union.
 */
export function repairMode(): fc.Arbitrary<RepairMode> {
  return fc.constantFrom<RepairMode[]>('safe', 'aggressive');
}

// ---------------------------------------------------------------------------
// General-purpose JSON value arbitrary: full unicode strings, full numeric
// range, used wherever the test only needs `JSON.stringify(value)` and does
// not need to perform textual surgery on the result.
// ---------------------------------------------------------------------------

function jsonNumber(): fc.Arbitrary<number> {
  return fc.oneof(
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.constantFrom(
      0,
      -0,
      1,
      -1,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      1e21,
      -1e21,
      1.5e-300,
      123456789012345,
    ),
  );
}

function jsonStringUnicode(): fc.Arbitrary<string> {
  return fc.oneof(
    fc.string({ maxLength: 32 }),
    fc.string({ unit: 'grapheme', maxLength: 32 }),
    fc.string({ unit: 'binary', maxLength: 32 }),
  );
}

function jsonPrimitive(): fc.Arbitrary<unknown> {
  return fc.oneof(fc.constant(null), fc.boolean(), jsonNumber(), jsonStringUnicode());
}

function jsonValueAt(depth: number): fc.Arbitrary<unknown> {
  if (depth <= 0) {
    return jsonPrimitive();
  }
  return fc.oneof(
    { weight: 4, arbitrary: jsonPrimitive() },
    { weight: 2, arbitrary: fc.array(jsonValueAt(depth - 1), { maxLength: 5 }) },
    {
      weight: 2,
      arbitrary: fc.dictionary(jsonStringUnicode(), jsonValueAt(depth - 1), { maxKeys: 5 }),
    },
  );
}

/** Any JSON-representable value, recursively bounded to `MAX_VALUE_DEPTH`. */
export function jsonValue(depth: number = MAX_VALUE_DEPTH): fc.Arbitrary<unknown> {
  return jsonValueAt(depth);
}

// ---------------------------------------------------------------------------
// Structural serializer: builds JSON text while recording the exact offset of
// every structural token it writes. This lets corruption tests target real
// structural positions (a comma between siblings, a closing brace, a key's
// quote delimiters) with certainty, instead of scanning finished text with
// pattern matching that arbitrary string/unicode content could fool.
// ---------------------------------------------------------------------------

export interface SerializedJson {
  text: string;
  commaPositions: number[];
  colonPositions: number[];
  openBracePositions: number[];
  closeBracePositions: number[];
  openBracketPositions: number[];
  closeBracketPositions: number[];
  /** Offsets of the opening quote of every object key, in the order written. */
  keyQuoteStarts: number[];
  /** Offsets of the opening quote of every string value, in the order written. */
  stringValueQuoteStarts: number[];
}

export function serializeJson(value: unknown): SerializedJson {
  const result: SerializedJson = {
    text: '',
    commaPositions: [],
    colonPositions: [],
    openBracePositions: [],
    closeBracePositions: [],
    openBracketPositions: [],
    closeBracketPositions: [],
    keyQuoteStarts: [],
    stringValueQuoteStarts: [],
  };

  function build(v: unknown): void {
    if (v === null || typeof v === 'boolean' || typeof v === 'number') {
      result.text += JSON.stringify(v);
      return;
    }
    if (typeof v === 'string') {
      result.stringValueQuoteStarts.push(result.text.length);
      result.text += JSON.stringify(v);
      return;
    }
    if (Array.isArray(v)) {
      result.openBracketPositions.push(result.text.length);
      result.text += '[';
      v.forEach((item, index) => {
        if (index > 0) {
          result.commaPositions.push(result.text.length);
          result.text += ',';
        }
        build(item);
      });
      result.closeBracketPositions.push(result.text.length);
      result.text += ']';
      return;
    }
    // Plain object.
    const entries = Object.entries(v as Record<string, unknown>);
    result.openBracePositions.push(result.text.length);
    result.text += '{';
    entries.forEach(([key, val], index) => {
      if (index > 0) {
        result.commaPositions.push(result.text.length);
        result.text += ',';
      }
      result.keyQuoteStarts.push(result.text.length);
      result.text += JSON.stringify(key);
      result.colonPositions.push(result.text.length);
      result.text += ':';
      build(val);
    });
    result.closeBracePositions.push(result.text.length);
    result.text += '}';
  }

  build(value);
  return result;
}

// ---------------------------------------------------------------------------
// Constrained JSON value arbitrary for corruption tests: identifier-safe
// keys and quote/backslash-free ASCII string content, so that textual
// corruption transforms (flipping a delimiter, stripping quotes from a key)
// can never accidentally collide with content the value itself contains.
// Numbers still draw from the full numeric arbitrary, since no corruption in
// this suite touches number tokens.
// ---------------------------------------------------------------------------

const IDENTIFIER_START = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_';
const IDENTIFIER_PART = `${IDENTIFIER_START}0123456789`;

const SAFE_STRING_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).filter(
  (ch) => ch !== '"' && ch !== "'" && ch !== '\\',
);

export function identifierKey(): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.constantFrom(...IDENTIFIER_START.split('')),
      fc.array(fc.constantFrom(...IDENTIFIER_PART.split('')), { maxLength: 7 }),
    )
    .map(([first, rest]) => first + rest.join(''));
}

function safeAsciiString(): fc.Arbitrary<string> {
  return fc.string({ unit: fc.constantFrom(...SAFE_STRING_CHARS), maxLength: 24 });
}

function simplePrimitive(): fc.Arbitrary<unknown> {
  return fc.oneof(fc.constant(null), fc.boolean(), jsonNumber(), safeAsciiString());
}

function simpleValueAt(depth: number): fc.Arbitrary<unknown> {
  if (depth <= 0) {
    return simplePrimitive();
  }
  return fc.oneof(
    { weight: 3, arbitrary: simplePrimitive() },
    { weight: 2, arbitrary: fc.array(simpleValueAt(depth - 1), { minLength: 1, maxLength: 4 }) },
    {
      weight: 2,
      arbitrary: fc.dictionary(identifierKey(), simpleValueAt(depth - 1), {
        minKeys: 1,
        maxKeys: 4,
      }),
    },
  );
}

/**
 * A JSON value restricted to identifier-safe keys and quote/backslash-free
 * ASCII string content, with every container guaranteed non-empty. Suitable
 * as the base for textual corruption transforms that must reliably find at
 * least one eligible target position.
 */
export function simpleJsonValue(depth = 4): fc.Arbitrary<unknown> {
  return simpleValueAt(depth);
}

/**
 * Same constraints as {@link simpleJsonValue}, but the top-level value is
 * always an array or object (never a bare primitive). Several corruption
 * transforms — inserting a comment right after the opening bracket, wrapping
 * in a Markdown fence — assume a container at position 0.
 */
export function simpleJsonContainer(depth = 4): fc.Arbitrary<unknown> {
  return fc.oneof(
    fc.array(simpleValueAt(depth - 1), { minLength: 1, maxLength: 4 }),
    fc.dictionary(identifierKey(), simpleValueAt(depth - 1), { minKeys: 1, maxKeys: 4 }),
  );
}
