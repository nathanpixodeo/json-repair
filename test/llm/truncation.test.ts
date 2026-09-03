import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

// Every case below must produce output that JSON.parse succeeds on and that
// retains whatever data survived the cut-off point.

describe('a fence that never closes', () => {
  it('repairs JSON inside a fence with no closing marker at all', () => {
    const input = '```json\n{"name": "Alice", "age": 30';
    const result = repairJson(input);
    expect(() => JSON.parse(result)).not.toThrow();
    expect(JSON.parse(result)).toEqual({ name: 'Alice', age: 30 });
  });

  it('closes nested containers inside a never-closing fence', () => {
    const input = '```json\n{"items": [1, 2, {"nested": true';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ items: [1, 2, { nested: true }] });
  });
});

describe('an object truncated mid-value', () => {
  it('recovers surviving digits from a number truncated mid-fraction', () => {
    const input = '{"a":1,"price":12.';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ a: 1, price: 12 });
  });

  it('closes a value that is itself a truncated nested object', () => {
    const input = '{"a":1,"b":{"c":2';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ a: 1, b: { c: 2 } });
  });
});

describe('an object truncated mid-key', () => {
  it('drops a key that was cut off before its value, keeping prior members', () => {
    const input = '{"name": "Alice", "ag';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ name: 'Alice' });
  });
});

describe('an object truncated mid-string', () => {
  it('closes a string value that was cut off before its closing quote', () => {
    const input = '{"name": "Ali';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ name: 'Ali' });
  });

  it('closes a longer string value cut off mid-sentence', () => {
    const input = '{"summary": "The quick brown fox jumps over the la';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({
      summary: 'The quick brown fox jumps over the la',
    });
  });
});

describe('an object truncated after a comma', () => {
  it('drops a dangling trailing comma left at end of input', () => {
    const input = '{"a":1,';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it('drops a dangling trailing comma inside a truncated array', () => {
    const input = '[1,2,';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual([1, 2]);
  });
});

describe('an object truncated after a colon', () => {
  it('drops a key left with no value at all at end of input', () => {
    const input = '{"a":1,"b":';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });
});

describe('a nested array truncated several levels deep', () => {
  it('closes every open array level in the correct order', () => {
    const input = '{"a":[1,[2,[3,4';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ a: [1, [2, [3, 4]]] });
  });

  it('closes a deeper chain of nested arrays cut off mid-element', () => {
    const input = '[[1,[2,[3,[4,5';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual([[1, [2, [3, [4, 5]]]]]);
  });

  it('closes nested arrays truncated immediately after an opening bracket', () => {
    const input = '{"a":[1,[2,[';
    const result = repairJson(input);
    const value = JSON.parse(result) as { a: unknown[] };
    expect(value.a[0]).toBe(1);
    expect(Array.isArray(value.a[1])).toBe(true);
  });
});
