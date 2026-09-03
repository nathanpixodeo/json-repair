import { describe, expect, it } from 'vitest';

import { parseJson, repairJson } from '../../src/index.js';

describe('prototype pollution resistance', () => {
  it('does not pollute Object.prototype for a well-formed literal __proto__ key', () => {
    const input = '{"__proto__": {"polluted": true}}';
    const json = repairJson(input);
    // Zero repairs are needed for this already-valid input, so the formatting
    // rule requires the original text to come back verbatim.
    expect(json).toBe(input);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);

    const parsed = JSON.parse(json) as Record<string, unknown>;
    const nativeParsed = JSON.parse(input) as Record<string, unknown>;
    // JSON.parse defines "__proto__" as an ordinary own data property, not a
    // prototype mutation. The repaired output must parse to the exact same
    // shape as parsing the original text directly.
    expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')).toEqual(
      Object.getOwnPropertyDescriptor(nativeParsed, '__proto__'),
    );
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('does not pollute Object.prototype for a constructor/prototype key chain', () => {
    const input = '{"constructor": {"prototype": {"x": 1}}}';
    const json = repairJson(input);
    expect(json).toBe(input);

    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect({}.constructor).toBe(Object);

    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.constructor).toEqual({ prototype: { x: 1 } });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('does not pollute Object.prototype when the same shape requires repairs', () => {
    const input = '{__proto__:{polluted:true},}';
    const json = repairJson(input);
    expect(JSON.parse(json)).toBeTruthy();
    expect(() => JSON.parse(json)).not.toThrow();

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);

    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')).toBeDefined();
    expect(parsed.__proto__).toEqual({ polluted: true });
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('does not pollute Object.prototype via parseJson directly, safe and aggressive', () => {
    for (const mode of ['safe', 'aggressive'] as const) {
      const value = parseJson<Record<string, unknown>>('{__proto__:{polluted:true},}', { mode });
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
      expect(value.__proto__).toEqual({ polluted: true });
    }
  });

  it('does not pollute Object.prototype for a nested __proto__ inside an array', () => {
    const input = '[{"__proto__":{"polluted":true}},{"__proto__":{"polluted":true}}]';
    const json = repairJson(input);
    const parsed = JSON.parse(json) as Record<string, unknown>[];
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    for (const entry of parsed) {
      expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
    }
  });
});

describe('repaired output always parses', () => {
  const hostileInputs: [string, string?][] = [
    ['{"__proto__": {"polluted": true}}'],
    ['{"constructor": {"prototype": {"x": 1}}}'],
    ['{__proto__:{polluted:true},}'],
    ['{"a":1,}'],
    ['[1,2,3,]'],
    ["{'a':'b'}"],
    ['{a:1,b:2}'],
    ['```json\n{"a":1}\n```'],
    ['Here is the payload: {"a": [1, 2, {"b": true}]} thanks.'],
    ['{"a": "line one\nstill in string", "b": 2}'],
    ['{"a":{"b":{"c":{"d":1'],
    ['{"a":1 "b":2}'],
    ['{"a": True, "b": None, "c": NaN}', 'aggressive'],
    ['{"a": 0x1F}', 'aggressive'],
    ['[1,,2]', 'aggressive'],
    ['{"a": "he said "hi" ok"}', 'aggressive'],
    ['{ // comment\n "a": 1 /* trailing */ }'],
    ['﻿{"a":1,}'],
    ['{"emoji":"😀","escaped":"\\u00e9"}'],
    ['   \n  {"a":1}   \n  '],
  ];

  for (const [input, mode] of hostileInputs) {
    it(`parses the repaired output of ${JSON.stringify(input).slice(0, 60)} (${mode ?? 'safe'})`, () => {
      const json = repairJson(input, { mode: mode as 'safe' | 'aggressive' | undefined });
      expect(() => JSON.parse(json)).not.toThrow();
    });
  }
});
