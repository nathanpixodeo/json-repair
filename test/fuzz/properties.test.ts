import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { isJsonRepairError, repairJson } from '../../src/index.js';
import { jsonValue, repairMode, serializeJson } from './arbitraries.js';

/**
 * Structural corruption used by several properties below: inserts a comma
 * immediately before a randomly chosen, non-empty container's closing
 * brace or bracket. Built from `serializeJson`'s recorded offsets, so it
 * works correctly regardless of what the generated strings contain.
 */
function insertTrailingComma(value: unknown, pick: number): string | undefined {
  const serialized = serializeJson(value);
  const closes = [...serialized.closeBracePositions, ...serialized.closeBracketPositions].filter(
    (pos) => serialized.text[pos - 1] !== '{' && serialized.text[pos - 1] !== '[',
  );
  if (closes.length === 0) {
    return undefined;
  }
  const target = closes[pick % closes.length]!;
  return `${serialized.text.slice(0, target)},${serialized.text.slice(target)}`;
}

interface MutationOp {
  kind: 'delete' | 'insert' | 'swap';
  fraction: number;
  char: string;
}

function applyMutations(text: string, ops: readonly MutationOp[]): string {
  let result = text;
  for (const op of ops) {
    if (result.length === 0) {
      continue;
    }
    const pos = Math.min(result.length - 1, Math.max(0, Math.floor(op.fraction * result.length)));
    if (op.kind === 'delete') {
      result = result.slice(0, pos) + result.slice(pos + 1);
    } else if (op.kind === 'insert') {
      result = result.slice(0, pos) + op.char + result.slice(pos);
    } else if (pos + 1 < result.length) {
      const chars = result.split('');
      const tmp = chars[pos]!;
      chars[pos] = chars[pos + 1]!;
      chars[pos + 1] = tmp;
      result = chars.join('');
    }
  }
  return result;
}

describe('property 1: validity preservation', () => {
  it('returns an already-valid document unchanged, with no reported repairs', () => {
    fc.assert(
      fc.property(jsonValue(), (value) => {
        const text = JSON.stringify(value);
        const result = repairJson(text, { returnMetadata: true });
        expect(result.json).toBe(text);
        expect(result.changed).toBe(false);
        expect(result.repairs).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe('property 3: idempotence', () => {
  it('repairing an already-repaired document is a no-op', () => {
    fc.assert(
      fc.property(jsonValue(), fc.nat(), repairMode(), (value, pick, mode) => {
        const corrupted = insertTrailingComma(value, pick);
        fc.pre(corrupted !== undefined);
        const once = repairJson(corrupted, { mode });
        const twice = repairJson(once, { mode });
        expect(twice).toBe(once);
      }),
      { numRuns: 300 },
    );
  });
});

describe('property 4: determinism', () => {
  it('repairing the same valid input twice yields byte-identical output', () => {
    fc.assert(
      fc.property(jsonValue(), repairMode(), (value, mode) => {
        const text = JSON.stringify(value);
        expect(repairJson(text, { mode })).toBe(repairJson(text, { mode }));
      }),
      { numRuns: 300 },
    );
  });

  it('repairing the same corrupted input twice yields byte-identical output', () => {
    fc.assert(
      fc.property(jsonValue(), fc.nat(), repairMode(), (value, pick, mode) => {
        const corrupted = insertTrailingComma(value, pick);
        fc.pre(corrupted !== undefined);
        expect(repairJson(corrupted, { mode })).toBe(repairJson(corrupted, { mode }));
      }),
      { numRuns: 300 },
    );
  });
});

describe('property 5: mode monotonicity', () => {
  it('whenever safe mode succeeds, aggressive mode returns identical bytes', () => {
    fc.assert(
      fc.property(jsonValue(), fc.nat(), (value, pick) => {
        const corrupted = insertTrailingComma(value, pick);
        fc.pre(corrupted !== undefined);
        let safeOutcome: string | undefined;
        try {
          safeOutcome = repairJson(corrupted, { mode: 'safe' });
        } catch {
          safeOutcome = undefined;
        }
        fc.pre(safeOutcome !== undefined);
        expect(repairJson(corrupted, { mode: 'aggressive' })).toBe(safeOutcome);
      }),
      { numRuns: 300 },
    );
  });
});

describe('property 6: truncation safety', () => {
  it('truncating a valid document at any offset either fails cleanly or repairs to parseable JSON', () => {
    fc.assert(
      fc.property(
        jsonValue(),
        fc.float({ min: 0, max: Math.fround(0.999), noNaN: true }),
        repairMode(),
        (value, fraction, mode) => {
          const text = JSON.stringify(value);
          const cut = Math.floor(fraction * text.length);
          const truncated = text.slice(0, cut);
          try {
            const repaired = repairJson(truncated, { mode });
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

describe('property 9: metadata coherence', () => {
  it('changed, repairs and position/line/column fields are mutually consistent', () => {
    fc.assert(
      fc.property(
        jsonValue(),
        fc.boolean(),
        fc.nat(),
        repairMode(),
        (value, corrupt, pick, mode) => {
          const text = JSON.stringify(value);
          const corrupted = corrupt ? insertTrailingComma(value, pick) : undefined;
          const input = corrupted ?? text;

          const result = repairJson(input, { mode, returnMetadata: true });
          expect(result.changed).toBe(result.json !== input);
          expect(result.repairs.length === 0).toBe(!result.changed);
          for (const repair of result.repairs) {
            if (repair.position !== undefined) {
              expect(repair.position).toBeGreaterThanOrEqual(0);
              expect(repair.position).toBeLessThanOrEqual(input.length);
            }
            if (repair.line !== undefined) {
              expect(repair.line).toBeGreaterThanOrEqual(1);
            }
            if (repair.column !== undefined) {
              expect(repair.column).toBeGreaterThanOrEqual(1);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('property 10: random single-character mutation fuzzing', () => {
  it('one to five random insert/delete/swap mutations never crash the repairer', () => {
    fc.assert(
      fc.property(
        jsonValue(),
        fc.array(
          fc.record({
            kind: fc.constantFrom<'delete' | 'insert' | 'swap'>('delete', 'insert', 'swap'),
            fraction: fc.float({ min: 0, max: Math.fround(0.999), noNaN: true }),
            char: fc.string({ minLength: 1, maxLength: 1 }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        repairMode(),
        (value, ops, mode) => {
          const text = JSON.stringify(value);
          const mutated = applyMutations(text, ops);
          try {
            const repaired = repairJson(mutated, { mode });
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
