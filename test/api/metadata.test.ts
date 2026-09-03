import { describe, expect, it } from 'vitest';

import {
  REPAIR_TYPES,
  extractAllJson,
  extractJson,
  parseJson,
  repairJson,
  type RepairOperation,
} from '../../src/index.js';

/**
 * Coverage for the `RepairResult` metadata contract: the exact shape of
 * `returnMetadata: true`, the `changed`/`repairs` invariant, the
 * `REPAIR_TYPES` registry, line/column accuracy against a hand-checked
 * fixture, determinism of repeated runs, `parseJson`'s equivalence to
 * `JSON.parse(repairJson(x))`, and the `extractJson` / `extractAllJson`
 * selection and deduplication rules.
 *
 * Exotic whitespace characters (a non-breaking space, an ideographic space,
 * a non-leading byte order mark) are written as explicit `\u` escapes
 * throughout this file rather than as raw characters, so they can never be
 * confused with an ordinary ASCII space in source or in a diff.
 */

const NBSP = ' ';
const IDEOGRAPHIC_SPACE = '　';
const BOM = '﻿';

describe('RepairResult shape', () => {
  it('has exactly the three documented keys', () => {
    const result = repairJson('{a:1,}', { returnMetadata: true });
    expect(Object.keys(result).sort()).toEqual(['changed', 'json', 'repairs']);
  });

  it('changed reflects whether json differs from the input, across several fixtures', () => {
    const fixtures = [
      '{"a":1}', // already valid, byte-identical
      '{a:1,}', // needs repair
      `{"a":${NBSP}1}`, // valid structure, but exotic whitespace between tokens
      '{\n  "a": 1,\n  "b": [1, 2]\n}', // already valid, multi-line
    ];
    for (const input of fixtures) {
      const result = repairJson(input, { returnMetadata: true });
      expect(result.changed).toBe(result.json !== input);
    }
  });

  it('repairs is empty if and only if changed is false, across several fixtures', () => {
    const fixtures = [
      '{"a":1}',
      '{a:1,}',
      `{"a":${NBSP}1}`,
      `{"a":1,${IDEOGRAPHIC_SPACE}"b":2}`, // ideographic space is exotic whitespace too
      `${BOM}{"a":1}`, // leading BOM alone is still a repair
      '{\n  "a": 1,\n  "b": [1, 2]\n}',
    ];
    for (const input of fixtures) {
      const result = repairJson(input, { returnMetadata: true });
      expect(result.repairs.length === 0).toBe(!result.changed);
    }
  });

  it('reports a single normalized-whitespace repair for a non-breaking space between tokens', () => {
    // A plain ASCII space here is ordinary JSON whitespace and must NOT be
    // reported as a repair.
    const plain = repairJson('{"a": 1}', { returnMetadata: true });
    expect(plain.changed).toBe(false);
    expect(plain.repairs).toEqual([]);

    // Only the exotic non-breaking space, used here in place of the ASCII
    // space, is reported.
    const exotic = repairJson(`{"a":${NBSP}1}`, { returnMetadata: true });
    expect(exotic.changed).toBe(true);
    expect(exotic.repairs).toEqual([
      expect.objectContaining({
        type: 'normalized-whitespace',
        message: 'Replaced whitespace that JSON does not allow between tokens',
      }),
    ]);
    expect(exotic.json).toBe('{"a":1}');
  });
});

describe('REPAIR_TYPES', () => {
  it('has 23 unique members, each a string', () => {
    expect(REPAIR_TYPES.length).toBe(23);
    expect(new Set(REPAIR_TYPES).size).toBe(23);
    for (const type of REPAIR_TYPES) {
      expect(typeof type).toBe('string');
    }
  });

  it('includes normalized-whitespace', () => {
    expect(REPAIR_TYPES).toContain('normalized-whitespace');
  });

  it('every repair produced by the engine is a member of REPAIR_TYPES', () => {
    const known = new Set<string>(REPAIR_TYPES);
    const fixtures = [
      `${BOM}{a:1,'b':'two',c:3,}Trailing note.`,
      '{"a":True,"b":None,"c":NaN}',
      '{"a":.5,"b":+1,"c":0x1F,}',
      '{"a":"he said \\"hi\\", ok"}',
      '{"a":"open',
      '{"a":{"b":[1,2',
      "{'a': 'it's fine', 'b': 2}",
      '{ // hi\n "a": 1 /* x */ }',
      `{"a": 1,${IDEOGRAPHIC_SPACE}"b":2}`,
      'Here: {"a":1} done.',
    ];
    for (const input of fixtures) {
      const result = repairJson(input, { mode: 'aggressive', returnMetadata: true });
      for (const repair of result.repairs) {
        expect(known.has(repair.type)).toBe(true);
      }
    }
  });
});

describe('repair positions and messages are sane', () => {
  it('every repair position lies within the input and every message is non-empty', () => {
    const input = `${BOM}{a:1,'b':'two',c:3,}\nTrailing note.`;
    const result = repairJson(input, { mode: 'aggressive', returnMetadata: true });
    expect(result.repairs.length).toBeGreaterThan(0);
    for (const repair of result.repairs) {
      expect(repair.position).toBeGreaterThanOrEqual(0);
      expect(repair.position).toBeLessThanOrEqual(input.length);
      expect(repair.message).toBeTruthy();
      expect(typeof repair.message).toBe('string');
    }
  });

  it('matches hand-counted line/column numbers on a multi-line fixture', () => {
    // Fixture, indexed from 0 (BOM and NBSP are each a single UTF-16 code unit):
    //   0        BOM
    //   1-5      "Note:"
    //   6        "\n"                    <- ends line 1
    //   7        "{"                     <- line 2, col 1
    //   8        "a"                     <- line 2, col 2 (quoted-key)
    //   12       "'"                     <- line 2, col 6 (normalized-quotes, opening quote of 'b')
    //   16       "'"                     <- line 2, col 10 (normalized-quotes, opening quote of 'two')
    //   22       "c"                     <- line 2, col 16 (quoted-key)
    //   25       ","                     <- line 2, col 19 (removed-trailing-comma)
    //   27       "\n"                    <- line 2, col 21 (removed-trailing-content starts here)
    //   28...    "Trailing note."        <- line 3
    const input = `${BOM}Note:\n{a:1,'b':'two',c:3,}\nTrailing note.`;
    expect(input[6]).toBe('\n');
    expect(input[27]).toBe('\n');

    const result = repairJson(input, { mode: 'aggressive', returnMetadata: true });

    const byType = (type: string): RepairOperation[] =>
      result.repairs.filter((r) => r.type === type);

    expect(byType('removed-byte-order-mark')).toEqual([
      expect.objectContaining({ position: 0, line: 1, column: 1 }),
    ]);
    expect(byType('extracted-json')).toEqual([
      expect.objectContaining({ position: 7, line: 2, column: 1 }),
    ]);
    expect(byType('quoted-key')).toEqual([
      expect.objectContaining({ position: 8, line: 2, column: 2 }),
      expect.objectContaining({ position: 22, line: 2, column: 16 }),
    ]);
    expect(byType('normalized-quotes')).toEqual([
      expect.objectContaining({ position: 12, line: 2, column: 6 }),
      expect.objectContaining({ position: 16, line: 2, column: 10 }),
    ]);
    expect(byType('removed-trailing-comma')).toEqual([
      expect.objectContaining({ position: 25, line: 2, column: 19 }),
    ]);
    expect(byType('removed-trailing-content')).toEqual([
      expect.objectContaining({ position: 27, line: 2, column: 21 }),
    ]);

    expect(result.repairs.map((r) => r.type)).toEqual([
      'removed-byte-order-mark',
      'extracted-json',
      'quoted-key',
      'normalized-quotes',
      'normalized-quotes',
      'quoted-key',
      'removed-trailing-comma',
      'removed-trailing-content',
    ]);
    expect(result.json).toBe('{"a":1,"b":"two","c":3}');
    expect(result.changed).toBe(true);
  });
});

describe('determinism', () => {
  it('repairing the same input twice yields byte-identical output', () => {
    const fixtures = [
      '{a:1,}',
      "{'a':'b'}",
      '{"a":1',
      '[1,2,3,]',
      'Here: {"a":1} done.',
      '```json\n{"a":1}\n```',
      '{ // hi\n "a": 1 }',
      '{"a":True,"b":None}',
      '{"a":"value,\n"}',
      '{"a":.5,"b":+1,"c":0x1F}',
      '{"a":"he said "hi""}',
      "{'a': 'it\\'s fine'}",
      '{"a":1,"b',
      '[[[[1]]]]',
      `${BOM}{"a":1}`,
    ];
    for (const input of fixtures) {
      const first = repairJson(input, { mode: 'aggressive' });
      const second = repairJson(input, { mode: 'aggressive' });
      expect(second).toBe(first);
    }
  });
});

describe('parseJson', () => {
  it('returns a value deep-equal to JSON.parse(repairJson(x)) for a variety of inputs', () => {
    const fixtures = [
      '{"a":1}',
      '{a:1,}',
      "{'a':'b','c':[1,2,3,]}",
      '{"nested":{"deep":[1,2,{"x":true}]}}',
      '{"a":True,"b":None}',
    ];
    for (const input of fixtures) {
      const viaParseJson = parseJson(input, { mode: 'aggressive' });
      const viaRepairThenParse: unknown = JSON.parse(repairJson(input, { mode: 'aggressive' }));
      expect(viaParseJson).toEqual(viaRepairThenParse);
    }
  });

  it('is generic and its type parameter is an unchecked assertion, like JSON.parse', () => {
    interface Shape {
      a: number;
    }
    const value = parseJson<Shape>('{a:1,}');
    expect(value).toEqual({ a: 1 });
  });
});

describe('extractJson / extractAllJson select strategies', () => {
  // Three blocks of increasing repair count / differing length:
  //  - "{a:1}"                                    verbatim length 5, needs repair (bare key)
  //  - {"c":3,"d":[1,2,3],"e":{"nested":true}}     verbatim, already valid, length 41 (longest)
  //  - [1,2,]                                      verbatim length 8, needs repair (trailing comma)
  const doc = 'First: {a:1} Second: {"c":3,"d":[1,2,3],"e":{"nested":true}} Third: [1,2,]';
  const firstBlock = '{a:1}';
  const secondBlock = '{"c":3,"d":[1,2,3],"e":{"nested":true}}';
  const thirdBlock = '[1,2,]';

  it('"first" returns the earliest repairable candidate, in document order', () => {
    expect(extractJson(doc, { select: 'first' })).toBe(firstBlock);
  });

  it('"last" returns the last repairable candidate, in document order', () => {
    expect(extractJson(doc, { select: 'last' })).toBe(thirdBlock);
  });

  it('"best" prefers fewest repairs, then longest: the already-valid middle block wins', () => {
    expect(extractJson(doc, { select: 'best' })).toBe(secondBlock);
  });

  it('"largest" prefers the longest span regardless of repair count', () => {
    expect(extractJson(doc, { select: 'largest' })).toBe(secondBlock);
  });

  it('defaults to "best" when select is not given', () => {
    expect(extractJson(doc)).toBe(secondBlock);
  });

  it('extractAllJson returns every block, verbatim, in document order', () => {
    expect(extractAllJson(doc)).toEqual([firstBlock, secondBlock, thirdBlock]);
  });

  it('extractAllJson returns an empty array, not a thrown error, when nothing is found', () => {
    expect(extractAllJson('no json anywhere in this sentence')).toEqual([]);
  });

  it('extractJson throws NO_JSON_FOUND when nothing is found', () => {
    expect(() => extractJson('no json anywhere in this sentence')).toThrowError(
      expect.objectContaining({ code: 'NO_JSON_FOUND' }),
    );
  });

  it('does not double-report a value nested inside an already-reported one', () => {
    expect(extractAllJson('[{"a":1}]')).toEqual(['[{"a":1}]']);
    expect(extractAllJson('{"a":[1,2]}')).toEqual(['{"a":[1,2]}']);
  });
});
