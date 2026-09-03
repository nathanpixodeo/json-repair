import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('typographic quote normalisation', () => {
  // Each row opens a string with a curly/typographic quote character and closes it
  // with its natural partner; both must normalise to a plain ASCII double quote.
  const rows: [string, string, string][] = [
    ['LEFT/RIGHT SINGLE QUOTATION MARK', '\u2018', '\u2019'],
    ['LEFT/RIGHT DOUBLE QUOTATION MARK', '\u201c', '\u201d'],
    ['DOUBLE LOW-9 QUOTATION MARK (opener) / RIGHT DOUBLE (closer)', '\u201e', '\u201d'],
    ['DOUBLE HIGH-REVERSED-9 QUOTATION MARK (opener) / RIGHT DOUBLE (closer)', '\u201f', '\u201d'],
    ['SINGLE LOW-9 QUOTATION MARK (opener) / RIGHT SINGLE (closer)', '\u201a', '\u2019'],
    ['SINGLE HIGH-REVERSED-9 QUOTATION MARK (opener) / RIGHT SINGLE (closer)', '\u201b', '\u2019'],
  ];

  for (const [label, open, close] of rows) {
    it(`normalises ${label} to a standard double quote`, () => {
      const input = `{${open}a${close}:1,${open}b${close}:2,}`;
      const result = repairJson(input);
      expect(result).toBe('{"a":1,"b":2}');
      expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
    });
  }

  it('normalises a right single quote used as both opener and closer', () => {
    const input = '{\u2019a\u2019:1,}';
    const result = repairJson(input);
    expect(result).toBe('{"a":1}');
  });

  it('normalises a right double quote used as both opener and closer', () => {
    const input = '{\u201da\u201d:1,}';
    const result = repairJson(input);
    expect(result).toBe('{"a":1}');
  });

  it('normalises a curly-quoted string value alongside a curly-quoted key', () => {
    const input = '{\u201cname\u201d:\u2018Alice\u2019,}';
    const result = repairJson(input);
    expect(result).toBe('{"name":"Alice"}');
  });

  it('keeps a curly apostrophe inside a curly-quoted string as literal content', () => {
    // The string is opened with a LEFT SINGLE QUOTATION MARK and contains a RIGHT
    // SINGLE QUOTATION MARK mid-string, used as an apostrophe ("it's"). The probe
    // must recognise that the first candidate closer is not followed by anything
    // that looks like object continuation, and treat it as string content instead;
    // only the final ’ before the closing brace actually terminates the string.
    const input = '{"a": \u2018it\u2019s fine\u2019}';
    const result = repairJson(input, { returnMetadata: true });
    expect(result.json).toBe('{"a":"it\u2019s fine"}');
    expect(JSON.parse(result.json)).toEqual({ a: 'it\u2019s fine' });
  });

  it('keeps a curly quotation mark inside a double-low-9-quoted string as literal content', () => {
    const input = '{"a": \u201eshe said \u201chi\u201d today\u201d}';
    const result = repairJson(input, { returnMetadata: true });
    expect(JSON.parse(result.json)).toEqual({ a: 'she said \u201chi\u201d today' });
  });
});

describe('script and directionality preservation', () => {
  it('preserves right-to-left Arabic text byte for byte', () => {
    const input =
      '{"greeting":"\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645"}';
    expect(repairJson(input)).toBe(input);
  });

  it('preserves right-to-left Hebrew text through an unrelated repair', () => {
    const hebrew = '\u05e9\u05dc\u05d5\u05dd';
    const input = `{'greeting':"${hebrew}",}`;
    const result = repairJson(input);
    expect(result).toBe(`{"greeting":"${hebrew}"}`);
    expect(JSON.parse(result)).toEqual({ greeting: hebrew });
  });

  it('preserves combining marks in a decomposed character sequence', () => {
    // "e" + COMBINING ACUTE ACCENT (U+0301), not the precomposed U+00E9 - the
    // library must not normalise this to NFC.
    const decomposed = 'e\u0301clair';
    const input = `{'word':"${decomposed}",}`;
    const result = repairJson(input);
    expect(result).toBe(`{"word":"${decomposed}"}`);
    expect(Array.from(JSON.parse(result).word)).toEqual(Array.from(decomposed));
  });

  it('preserves a mixed-script string spanning several writing systems unchanged', () => {
    const mixed =
      'Hello \u041f\u0440\u0438\u0432\u0435\u0442 \u0645\u0631\u062d\u0628\u0627 \u4e16\u754c \ud83c\udf89';
    const input = `{"text":"${mixed}"}`;
    expect(repairJson(input)).toBe(input);
  });

  it('preserves a mixed-script key and value through an unrelated repair', () => {
    const key = '\u540d\u524d'; // "name" in Japanese
    const value = '\u0410\u043b\u0438\u0441\u0430'; // "Alisa" in Cyrillic
    const input = `{'${key}':"${value}",}`;
    const result = repairJson(input);
    expect(result).toBe(`{"${key}":"${value}"}`);
  });
});

describe('solidus (forward slash) handling', () => {
  it('leaves an already-valid escaped solidus untouched when nothing else needs repair', () => {
    const input = '{"a":"1\\/2"}';
    expect(repairJson(input)).toBe(input);
  });

  it('preserves an escaped solidus verbatim (not collapsed to a bare slash) through an unrelated repair', () => {
    const input = '{\'a\':"1\\/2",}';
    const result = repairJson(input);
    expect(result).toBe('{"a":"1\\/2"}');
    expect(JSON.parse(result)).toEqual({ a: '1/2' });
  });

  it('does not treat a bare slash inside a string as the start of a comment', () => {
    const input = "{'path': 'a/b/c', 'n': 1,}";
    const result = repairJson(input);
    expect(result).toBe('{"path":"a/b/c","n":1}');
  });

  it('does not treat a double slash (//) inside a URL string as a line comment', () => {
    const input = "{'url': 'http://example.com/page', 'n': 1,}";
    const result = repairJson(input);
    expect(result).toBe('{"url":"http://example.com/page","n":1}');
    expect(JSON.parse(result)).toEqual({ url: 'http://example.com/page', n: 1 });
  });

  it('does not treat a slash-star sequence inside a string as a block comment', () => {
    const input = "{'note': 'see /* appendix */ for details', 'n': 1,}";
    const result = repairJson(input);
    expect(JSON.parse(result)).toEqual({ note: 'see /* appendix */ for details', n: 1 });
  });
});

describe('line and paragraph separators inside strings', () => {
  it('keeps a raw U+2028 LINE SEPARATOR inside an already-valid string untouched', () => {
    const input = `{"a":"x${String.fromCharCode(0x2028)}y"}`;
    expect(repairJson(input)).toBe(input);
    expect(JSON.parse(repairJson(input))).toEqual({ a: `x${String.fromCharCode(0x2028)}y` });
  });

  it('keeps a raw U+2029 PARAGRAPH SEPARATOR inside an already-valid string untouched', () => {
    const input = `{"a":"x${String.fromCharCode(0x2029)}y"}`;
    expect(repairJson(input)).toBe(input);
  });

  it('preserves U+2028 as literal string content through an unrelated repair', () => {
    const input = `{'a':"x${String.fromCharCode(0x2028)}y",}`;
    const result = repairJson(input);
    expect(result).toBe(`{"a":"x${String.fromCharCode(0x2028)}y"}`);
    expect(JSON.parse(result)).toEqual({ a: `x${String.fromCharCode(0x2028)}y` });
  });

  it('preserves U+2029 as literal string content through an unrelated repair', () => {
    const input = `{'a':"x${String.fromCharCode(0x2029)}y",}`;
    const result = repairJson(input);
    expect(result).toBe(`{"a":"x${String.fromCharCode(0x2029)}y"}`);
    expect(JSON.parse(result)).toEqual({ a: `x${String.fromCharCode(0x2029)}y` });
  });
});
