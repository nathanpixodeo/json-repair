import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

// This library's whitespace scanner accepts a much broader set of Unicode space
// characters as inter-token trivia than the strict JSON grammar (which only allows
// space, tab, LF and CR). These characters are never valid standalone JSON on their
// own, so they always force the full repair parser to run rather than the plain
// JSON.parse fast path — the assertions below check the resulting *value* and
// *compacted text*, not the repairs metadata (whose shape for trivia-only fixes is
// intentionally left unspecified by this suite).

describe('non-standard Unicode whitespace accepted between tokens', () => {
  const NAMED_SPACES: [string, number][] = [
    ['NO-BREAK SPACE', 0x00a0],
    ['EN QUAD', 0x2000],
    ['EM QUAD', 0x2001],
    ['EN SPACE', 0x2002],
    ['EM SPACE', 0x2003],
    ['THREE-PER-EM SPACE', 0x2004],
    ['FOUR-PER-EM SPACE', 0x2005],
    ['SIX-PER-EM SPACE', 0x2006],
    ['FIGURE SPACE', 0x2007],
    ['PUNCTUATION SPACE', 0x2008],
    ['THIN SPACE', 0x2009],
    ['HAIR SPACE', 0x200a],
    ['IDEOGRAPHIC SPACE', 0x3000],
  ];

  for (const [name, code] of NAMED_SPACES) {
    const ws = String.fromCharCode(code);

    it(`accepts ${name} (U+${code.toString(16).toUpperCase().padStart(4, '0')}) between an object's comma and next key`, () => {
      const input = `{"a":1,${ws}"b":2}`;
      const result = repairJson(input);
      expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
      expect(result).toBe('{"a":1,"b":2}');
    });

    it(`accepts ${name} between a colon and its value`, () => {
      const input = `{"a":${ws}1,"b":2}`;
      const result = repairJson(input);
      expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
    });

    it(`accepts ${name} surrounding array elements`, () => {
      const input = `[1,${ws}2,${ws}3]`;
      const result = repairJson(input);
      expect(JSON.parse(result)).toEqual([1, 2, 3]);
    });

    it(`accepts ${name} used for leading/trailing padding around the whole document`, () => {
      const input = `${ws}${ws}{"a":1}${ws}`;
      const result = repairJson(input);
      expect(JSON.parse(result)).toEqual({ a: 1 });
    });
  }

  it('accepts a mix of several non-standard space characters in one document', () => {
    const input =
      '{' +
      String.fromCharCode(0x2000) +
      '"a":1,' +
      String.fromCharCode(0x00a0) +
      '"b":' +
      String.fromCharCode(0x3000) +
      '2' +
      String.fromCharCode(0x200a) +
      '}';
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
    expect(result).toBe('{"a":1,"b":2}');
  });

  it('does not treat these space characters as valid content inside a string', () => {
    // Inside a string, these characters are ordinary content and must be preserved
    // exactly rather than being skipped as trivia.
    const nbsp = String.fromCharCode(0x00a0);
    const ideographic = String.fromCharCode(0x3000);
    const input = `{'a':"x${nbsp}y${ideographic}z",}`;
    const result = repairJson(input);
    expect(result).toBe(`{"a":"x${nbsp}y${ideographic}z"}`);
    expect(JSON.parse(result)).toEqual({ a: `x${nbsp}y${ideographic}z` });
  });
});
