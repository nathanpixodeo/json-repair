import { describe, expect, it } from 'vitest';

import { parseJson, repairJson } from '../../src/index.js';

describe('string escape sequences are preserved exactly', () => {
  const escapes: [string, string][] = [
    ['double quote', '"a\\"b"'],
    ['backslash', '"a\\\\b"'],
    ['forward slash', '"a\\/b"'],
    ['backspace', '"a\\bb"'],
    ['form feed', '"a\\fb"'],
    ['newline', '"a\\nb"'],
    ['carriage return', '"a\\rb"'],
    ['tab', '"a\\tb"'],
    ['unicode escape', '"a\\u0041b"'],
    ['unicode escape for a control character', '"a\\u0001b"'],
  ];

  for (const [label, input] of escapes) {
    it(`keeps the ${label} escape byte-identical`, () => {
      expect(repairJson(input)).toBe(input);
    });
  }

  it('keeps a string containing every short escape in one literal', () => {
    const input = '"\\"\\\\\\/\\b\\f\\n\\r\\t"';
    expect(repairJson(input)).toBe(input);
  });
});

describe('surrogate pairs and astral-plane characters are preserved', () => {
  it('keeps a raw astral character (emoji) written directly in the string', () => {
    const input = '{"emoji":"😀"}';
    expect(repairJson(input)).toBe(input);
    expect(parseJson(input)).toEqual({ emoji: '😀' });
  });

  it('keeps a surrogate pair written as \\u escapes', () => {
    const input = '"\\ud83d\\ude00"';
    expect(repairJson(input)).toBe(input);
    expect(parseJson(input)).toBe(JSON.parse(input));
  });

  it('keeps mixed raw and escaped astral characters in the same string', () => {
    const input = '{"a":"😀\\ud83d\\ude01"}';
    expect(repairJson(input)).toBe(input);
  });
});

describe('every number form is preserved exactly as written', () => {
  const numbers: string[] = [
    '0',
    '-0',
    '1',
    '-1',
    '0.5',
    '-0.5',
    '1.0',
    '1.50',
    '10',
    '100',
    '1e10',
    '1E10',
    '1e+10',
    '1E+10',
    '1e-10',
    '1.5e-7',
    '1.5E+7',
    '123456789012345678901234567890',
    '0.000000000000000000000001',
    '9007199254740993',
    '1e999',
    '-1e-999',
    '3.141592653589793238462643383279',
  ];

  for (const number of numbers) {
    it(`preserves the literal "${number}" verbatim`, () => {
      expect(repairJson(number)).toBe(number);
    });

    it(`preserves "${number}" verbatim when nested in an object`, () => {
      const input = `{"n":${number}}`;
      expect(repairJson(input)).toBe(input);
    });
  }
});

describe('duplicate keys behave like the native JSON.parse', () => {
  it('keeps the last value for a duplicate key, matching JSON.parse', () => {
    const input = '{"a":1,"a":2}';
    expect(repairJson(input)).toBe(input);
    expect(parseJson(input)).toEqual(JSON.parse(input));
    expect(parseJson<{ a: number }>(input).a).toBe(2);
  });

  it('keeps the last value across three duplicate keys', () => {
    const input = '{"a":1,"a":2,"a":3}';
    expect(parseJson<{ a: number }>(input).a).toBe(JSON.parse(input).a);
  });
});

describe('a "__proto__" key is treated as ordinary data, not prototype pollution', () => {
  it('does not alter Object.prototype', () => {
    const input = '{"__proto__":{"polluted":true}}';
    parseJson<Record<string, unknown>>(input);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    expect((Object.prototype as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('stores "__proto__" as an own, enumerable data property', () => {
    const input = '{"__proto__":{"polluted":true}}';
    const result = parseJson<Record<string, unknown>>(input);
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
    expect(result.__proto__).toEqual({ polluted: true });
  });

  it('matches the native JSON.parse behaviour for a "__proto__" key', () => {
    const input = '{"__proto__":{"polluted":true}}';
    const ours = parseJson<Record<string, unknown>>(input);
    const native = JSON.parse(input) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(ours, '__proto__')).toBe(
      Object.prototype.hasOwnProperty.call(native, '__proto__'),
    );
  });
});

describe('parseJson deep-equals the native JSON.parse across a broad table of documents', () => {
  const documents: string[] = [
    '{}',
    '[]',
    'null',
    'true',
    'false',
    '0',
    '-17.5',
    '"a string"',
    '{"a":1,"b":"two","c":[1,2,3],"d":{"e":null,"f":true}}',
    '[1,"two",true,false,null,{"a":1},[1,2,[3,4]]]',
    '{"nested":{"deeply":{"nested":{"value":42}}}}',
    '["\\u0041\\u0042\\u0043"]',
    '{"unicode":"héllo wörld"}',
    '[0.1,0.2,0.3]',
    '{"big":123456789012345678901234567890}',
    '{"empty_object":{},"empty_array":[]}',
  ];

  for (const input of documents) {
    it(`matches JSON.parse for ${JSON.stringify(input)}`, () => {
      expect(parseJson(input)).toEqual(JSON.parse(input));
    });
  }
});
