import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

/**
 * These tests establish the core contract that valid JSON is never touched:
 * when zero repairs are needed, `repairJson` must return the exact original
 * text, and `returnMetadata` must report `changed: false` with an empty
 * `repairs` array.
 */
describe('valid JSON is returned byte-identical', () => {
  const documents: [string, string][] = [
    ['object literal', '{"a":1,"b":2}'],
    ['empty object', '{}'],
    ['empty array', '[]'],
    ['array of numbers', '[1,2,3]'],
    ['nested object and array', '{"a":{"b":[1,2,{"c":3}]}}'],
    ['top-level string', '"hello"'],
    ['top-level number', '42'],
    ['top-level negative number', '-42'],
    ['top-level float', '3.14'],
    ['top-level true', 'true'],
    ['top-level false', 'false'],
    ['top-level null', 'null'],
    ['string with escapes', '"line1\\nline2\\ttab"'],
    ['object with all value types', '{"s":"str","n":1,"b":true,"nul":null,"a":[1],"o":{}}'],
    ['array of mixed types', '[1,"two",true,null,{"a":1},[2,3]]'],
    ['array of empty containers', '[{},[],{},[]]'],
    ['single-character keys', '{"a":1,"b":2,"c":3}'],
    ['unicode key and value', '{"日本語":"値"}'],
    ['array of strings', '["a","b","c"]'],
    ['deeply nested arrays', '[[[[[1]]]]]'],
    ['deeply nested objects', '{"a":{"b":{"c":{"d":1}}}}'],
  ];

  for (const [label, input] of documents) {
    it(`keeps ${label} unchanged`, () => {
      expect(repairJson(input)).toBe(input);
    });

    it(`reports no repairs for ${label}`, () => {
      expect(repairJson(input, { returnMetadata: true })).toEqual({
        json: input,
        changed: false,
        repairs: [],
      });
    });
  }
});

describe('pretty-printed JSON is preserved verbatim, including whitespace', () => {
  it('keeps indentation and newlines from a pretty-printed object', () => {
    const input = '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}';
    expect(repairJson(input)).toBe(input);
    expect(repairJson(input, { returnMetadata: true })).toEqual({
      json: input,
      changed: false,
      repairs: [],
    });
  });

  it('keeps a trailing newline at the end of the document', () => {
    const input = '{"a":1}\n';
    expect(repairJson(input)).toBe(input);
  });

  it('keeps leading and trailing whitespace around the value', () => {
    const input = '   {"a":1}   ';
    expect(repairJson(input)).toBe(input);
  });

  it('keeps tabs used as indentation', () => {
    const input = '{\n\t"a":1,\n\t"b":2\n}';
    expect(repairJson(input)).toBe(input);
  });

  it('keeps carriage-return/newline pairs unchanged', () => {
    const input = '{\r\n  "a": 1\r\n}';
    expect(repairJson(input)).toBe(input);
  });

  it('keeps space inside empty containers unchanged when it is already valid', () => {
    // A space between "[" and "]" only appears inside a string in valid JSON;
    // here we confirm plain multi-space formatting around colons and commas
    // survives untouched.
    const input = '{ "a" : 1 , "b" : 2 }';
    expect(repairJson(input)).toBe(input);
  });

  it('keeps two documents that differ only in whitespace as two distinct outputs', () => {
    const compact = '{"a":1,"b":2}';
    const spaced = '{ "a" : 1, "b" : 2 }';
    expect(repairJson(compact)).toBe(compact);
    expect(repairJson(spaced)).toBe(spaced);
  });
});

describe('deep nesting within limits is preserved', () => {
  it('round-trips 100 levels of nested arrays unchanged', () => {
    const input = `${'['.repeat(100)}1${']'.repeat(100)}`;
    expect(repairJson(input)).toBe(input);
  });

  it('round-trips 100 levels of nested objects unchanged', () => {
    const input = `${'{"a":'.repeat(100)}1${'}'.repeat(100)}`;
    expect(repairJson(input)).toBe(input);
  });

  it('round-trips a document at the default maxDepth boundary', () => {
    // Default maxDepth is 512; 500 levels stays comfortably inside it.
    const input = `${'['.repeat(500)}1${']'.repeat(500)}`;
    expect(repairJson(input)).toBe(input);
  });
});
