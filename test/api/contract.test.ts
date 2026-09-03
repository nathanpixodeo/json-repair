import { describe, expect, expectTypeOf, it } from 'vitest';

import { repairJson, type RepairResult } from '../../src/index.js';

/**
 * Type-level coverage for the `repairJson` overloads.
 *
 * `repairJson` is declared with three signatures: a string-returning
 * overload used when `returnMetadata` is omitted or `false`, a
 * `RepairResult`-returning overload used when `returnMetadata` is literally
 * `true`, and a fallback signature for callers whose `options` type is not
 * known at the call site. `expectTypeOf` checks are compile-time only (they
 * do nothing at runtime), so every case also carries a matching runtime
 * `expect` so this file exercises real assertions under a plain
 * `vitest run`.
 */

describe('repairJson overload: no options', () => {
  it('returns a string', () => {
    const result = repairJson('{"a":1}');
    expectTypeOf(result).toEqualTypeOf<string>();
    expect(typeof result).toBe('string');
    expect(result).toBe('{"a":1}');
  });
});

describe('repairJson overload: returnMetadata omitted or false', () => {
  it('returns a string when options are given without returnMetadata', () => {
    const result = repairJson('{"a":1}', { mode: 'aggressive' });
    expectTypeOf(result).toEqualTypeOf<string>();
    expect(typeof result).toBe('string');
  });

  it('returns a string when returnMetadata is explicitly false', () => {
    const result = repairJson('{"a":1}', { returnMetadata: false });
    expectTypeOf(result).toEqualTypeOf<string>();
    expect(typeof result).toBe('string');
  });
});

describe('repairJson overload: returnMetadata true', () => {
  it('returns a RepairResult', () => {
    const result = repairJson('{a:1,}', { returnMetadata: true });
    expectTypeOf(result).toEqualTypeOf<RepairResult>();
    expect(result).toEqual({
      json: '{"a":1}',
      changed: true,
      repairs: expect.any(Array),
    });
  });

  it('the RepairResult fields have their documented types', () => {
    const result = repairJson('{a:1,}', { returnMetadata: true });
    expectTypeOf(result.json).toEqualTypeOf<string>();
    expectTypeOf(result.changed).toEqualTypeOf<boolean>();
    expectTypeOf(result.repairs).toEqualTypeOf<RepairResult['repairs']>();
    expect(typeof result.json).toBe('string');
    expect(typeof result.changed).toBe('boolean');
    expect(Array.isArray(result.repairs)).toBe(true);
  });
});

describe('repairJson overload: options typed as a plain RepairOptions', () => {
  it('resolves to the union string | RepairResult when returnMetadata is not statically known', () => {
    // The annotation is the whole point of this case: it widens the literal
    // `true` to `boolean` so the call cannot match either specific overload.
    // eslint-disable-next-line @typescript-eslint/no-inferrable-types
    const dynamicallyTrue: boolean = true;
    const result = repairJson('{"a":1}', { returnMetadata: dynamicallyTrue });
    // `expectTypeOf(...).toEqualTypeOf` cannot express a union that mixes a
    // primitive with an object type, so assert set equality by hand: each side
    // is assignable to the other exactly when the two types are the same.
    type Actual = typeof result;
    type Expected = string | RepairResult;
    const forward: Expected = result;
    const backward: Actual = forward;
    expectTypeOf(backward).toExtend<Expected>();
    // At runtime the value actually returned still matches whichever branch
    // the resolved option took.
    expect(result).toEqual({ json: '{"a":1}', changed: false, repairs: [] });
  });
});
