import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { extractJson, isJsonRepairError, parseJson, repairJson } from '../../src/index.js';
import { jsonValue, repairMode, serializeJson, simpleJsonContainer } from './arbitraries.js';
import type { SerializedJson } from './arbitraries.js';

function eligibleCloses(serialized: SerializedJson): number[] {
  return [...serialized.closeBracePositions, ...serialized.closeBracketPositions];
}

/**
 * Recursively rewrites -0 to +0. JSON text has no representation for
 * negative zero distinct from positive zero ("-0" and "0" both parse to the
 * IEEE-754 value +0 once written out and read back), so any round trip
 * through JSON text loses the sign of a zero the generator produced. Vitest's
 * `toEqual` uses `Object.is` semantics and treats -0 and +0 as different,
 * so round-trip assertions compare against a normalized copy of the original
 * value rather than the value itself.
 */
function normalizeNegativeZero(value: unknown): unknown {
  if (typeof value === 'number') {
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeNegativeZero);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        normalizeNegativeZero(entry),
      ]),
    );
  }
  return value;
}

/** Flips the outer delimiter of every key and string value from `"` to `'`. */
function toSingleQuoted(serialized: SerializedJson): string {
  const flip = new Set<number>();
  for (const start of [...serialized.keyQuoteStarts, ...serialized.stringValueQuoteStarts]) {
    flip.add(start);
    const end = serialized.text.indexOf('"', start + 1);
    flip.add(end);
  }
  let result = '';
  for (let i = 0; i < serialized.text.length; i += 1) {
    result += flip.has(i) ? "'" : serialized.text.charAt(i);
  }
  return result;
}

/** Strips the quotes from one identifier-safe object key, chosen by `pick`. */
function unquoteOneKey(serialized: SerializedJson, pick: number): string | undefined {
  if (serialized.keyQuoteStarts.length === 0) {
    return undefined;
  }
  const start = serialized.keyQuoteStarts[pick % serialized.keyQuoteStarts.length]!;
  const end = serialized.text.indexOf('"', start + 1);
  return (
    serialized.text.slice(0, start) +
    serialized.text.slice(start + 1, end) +
    serialized.text.slice(end + 1)
  );
}

describe('property 2: output always parses for a generated value plus a supported corruption', () => {
  it('returns text JSON.parse accepts, or throws a JsonRepairError, across five corruption strategies', () => {
    fc.assert(
      fc.property(
        simpleJsonContainer(),
        fc.nat(),
        fc.constantFrom(
          'trailing-comma',
          'single-quote',
          'unquoted-key',
          'stripped-bracket',
          'comment',
          'fence',
          'prose',
        ),
        repairMode(),
        (value, pick, strategy, mode) => {
          const serialized = serializeJson(value);
          let corrupted: string | undefined;
          switch (strategy) {
            case 'trailing-comma': {
              const closes = eligibleCloses(serialized);
              const target = closes[pick % closes.length]!;
              corrupted = `${serialized.text.slice(0, target)},${serialized.text.slice(target)}`;
              break;
            }
            case 'single-quote':
              corrupted = toSingleQuoted(serialized);
              break;
            case 'unquoted-key':
              corrupted = unquoteOneKey(serialized, pick);
              break;
            case 'stripped-bracket':
              corrupted = serialized.text.slice(0, -1);
              break;
            case 'comment':
              corrupted = `${serialized.text.slice(0, 1)}// injected\n${serialized.text.slice(1)}`;
              break;
            case 'fence':
              corrupted = '```json\n' + serialized.text + '\n```';
              break;
            case 'prose':
              corrupted = `Here is the payload: ${serialized.text} -- end of payload.`;
              break;
          }
          fc.pre(corrupted !== undefined);

          try {
            const repaired = repairJson(corrupted, { mode });
            expect(() => JSON.parse(repaired)).not.toThrow();
          } catch (error) {
            expect(isJsonRepairError(error)).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('property 7: round trip through each named supported corruption', () => {
  it('property 7a: recovers the original value after a trailing comma is inserted', () => {
    fc.assert(
      fc.property(simpleJsonContainer(), fc.nat(), repairMode(), (value, pick, mode) => {
        const serialized = serializeJson(value);
        const closes = eligibleCloses(serialized);
        fc.pre(closes.length > 0);
        const target = closes[pick % closes.length]!;
        const corrupted = `${serialized.text.slice(0, target)},${serialized.text.slice(target)}`;
        expect(parseJson(corrupted, { mode })).toEqual(normalizeNegativeZero(value));
      }),
      { numRuns: 200 },
    );
  });

  it('property 7b: recovers the original value after keys and strings are single-quoted', () => {
    fc.assert(
      fc.property(simpleJsonContainer(), repairMode(), (value, mode) => {
        const serialized = serializeJson(value);
        const corrupted = toSingleQuoted(serialized);
        expect(parseJson(corrupted, { mode })).toEqual(normalizeNegativeZero(value));
      }),
      { numRuns: 200 },
    );
  });

  it('property 7c: recovers the original value after an object key is unquoted', () => {
    fc.assert(
      fc.property(simpleJsonContainer(), fc.nat(), repairMode(), (value, pick, mode) => {
        const serialized = serializeJson(value);
        const corrupted = unquoteOneKey(serialized, pick);
        fc.pre(corrupted !== undefined);
        expect(parseJson(corrupted, { mode })).toEqual(normalizeNegativeZero(value));
      }),
      { numRuns: 200 },
    );
  });

  it('property 7d: recovers the original value after the outermost closing bracket is stripped', () => {
    fc.assert(
      fc.property(simpleJsonContainer(), repairMode(), (value, mode) => {
        const serialized = serializeJson(value);
        const corrupted = serialized.text.slice(0, -1);
        expect(parseJson(corrupted, { mode })).toEqual(normalizeNegativeZero(value));
      }),
      { numRuns: 200 },
    );
  });

  it('property 7e: recovers the original value after a // comment is inserted', () => {
    fc.assert(
      fc.property(simpleJsonContainer(), repairMode(), (value, mode) => {
        const serialized = serializeJson(value);
        const corrupted = `${serialized.text.slice(0, 1)}// injected comment\n${serialized.text.slice(1)}`;
        expect(parseJson(corrupted, { mode })).toEqual(normalizeNegativeZero(value));
      }),
      { numRuns: 200 },
    );
  });

  it('property 7f: recovers the original value after wrapping in a ```json fence', () => {
    fc.assert(
      fc.property(simpleJsonContainer(), repairMode(), (value, mode) => {
        const serialized = serializeJson(value);
        const corrupted = '```json\n' + serialized.text + '\n```';
        expect(parseJson(corrupted, { mode })).toEqual(normalizeNegativeZero(value));
      }),
      { numRuns: 200 },
    );
  });

  it('property 7g: recovers the original value after wrapping in surrounding prose', () => {
    fc.assert(
      fc.property(simpleJsonContainer(), repairMode(), (value, mode) => {
        const serialized = serializeJson(value);
        const corrupted = `Here is the payload: ${serialized.text} -- end of payload.`;
        expect(parseJson(corrupted, { mode })).toEqual(normalizeNegativeZero(value));
      }),
      { numRuns: 200 },
    );
  });
});

describe('property 8: extraction agreement', () => {
  it('repairJson(extractJson(x)) agrees with repairJson(x, { extract: true })', () => {
    fc.assert(
      fc.property(jsonValue(), (value) => {
        const text = JSON.stringify(value);
        const wrapped = `Some prose before. ${text} Some prose after.`;

        let extracted: string | undefined;
        try {
          extracted = extractJson(wrapped);
        } catch {
          extracted = undefined;
        }
        fc.pre(extracted !== undefined);

        let viaExtractThenRepair: string | undefined;
        try {
          viaExtractThenRepair = repairJson(extracted);
        } catch {
          viaExtractThenRepair = undefined;
        }

        let viaDirect: string | undefined;
        try {
          viaDirect = repairJson(wrapped, { extract: true });
        } catch {
          viaDirect = undefined;
        }

        fc.pre(viaExtractThenRepair !== undefined && viaDirect !== undefined);
        expect(viaExtractThenRepair).toBe(viaDirect);
      }),
      { numRuns: 300 },
    );
  });
});
