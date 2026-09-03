import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('mandatory SRS table rows involving quote normalization', () => {
  it('turns single-quoted delimiters into double quotes', () => {
    expect(repairJson("{'name':'John'}")).toBe('{"name":"John"}');
  });
});

describe('non-standard quote delimiters are normalized to double quotes', () => {
  it('normalizes single-quoted strings', () => {
    expect(repairJson("{'a':'b'}")).toBe('{"a":"b"}');
  });

  it('normalizes backtick-quoted strings', () => {
    expect(repairJson('{`a`:`b`}')).toBe('{"a":"b"}');
  });

  it('normalizes typographic double-quoted strings', () => {
    expect(repairJson('{\u201ca\u201d:\u201cb\u201d}')).toBe('{"a":"b"}');
  });

  it('normalizes typographic single-quoted strings', () => {
    expect(repairJson('{\u2018a\u2019:\u2018b\u2019}')).toBe('{"a":"b"}');
  });

  it('accepts a typographic opening quote closed by the matching opener character, not only its pair', () => {
    // The continuation probe accepts the opening character itself as a closer
    // too, since LLM output often mixes left/right typographic quotes.
    expect(repairJson('{\u201ca\u201c:1}')).toBe('{"a":1}');
  });
});

describe('apostrophes inside single-quoted strings are kept as content', () => {
  it('keeps an escaped apostrophe as a plain character', () => {
    expect(repairJson("{'a': 'it\\'s fine', 'b': 2}")).toBe('{"a":"it\'s fine","b":2}');
  });

  it('keeps a bare apostrophe inside a double-quoted string untouched', () => {
    const input = '{"a":"it\'s already valid"}';
    expect(repairJson(input)).toBe(input);
  });
});

describe('an unterminated string at the end of input is closed there', () => {
  it('closes a string that runs to end of input with no newline in it', () => {
    expect(repairJson('{"a": "hello')).toBe('{"a":"hello"}');
  });

  it('records terminated-string-at-eof followed by added-closing-brace', () => {
    const result = repairJson('{"a": "hello', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual([
      'terminated-string-at-eof',
      'added-closing-brace',
    ]);
  });

  it('closes a top-level unterminated string with no surrounding container', () => {
    expect(repairJson('"hello')).toBe('"hello"');
  });
});

describe('an unterminated string is rewound to its last line break when the tail looks structural', () => {
  it('closes the value at the newline and inserts the missing comma before the next key', () => {
    expect(repairJson('{"a": "value,\n "b": 2\n}')).toBe('{"a":"value,","b":2}');
  });

  it('rewinds when only whitespace and a closing brace follow the line break', () => {
    // Nothing but the newline and the object's own "}" remain after the
    // checkpoint, so the tail is judged structural and the string closes early.
    expect(repairJson('{"a": "value\n}')).toBe('{"a":"value"}');
  });

  it('does not rewind, and instead closes at end of input, when real content follows the newline', () => {
    // "extra" is not whitespace or closing punctuation, so the newline is kept
    // as an escaped character inside the string rather than treated as its end.
    expect(repairJson('{"a": "value\nextra')).toBe('{"a":"value\\nextra"}');
  });

  it('does not rewind a multi-line string that is already valid JSON', () => {
    // The newlines here are the two-character escape sequence "\n", so this is
    // already valid JSON and the fast path returns it byte-identical.
    const input = '{"code":"def f():\\n    return 1\\n"}';
    expect(repairJson(input)).toBe(input);
  });
});

describe('a quote that does not end the string is handled according to mode', () => {
  const input = '{"a": "he said "hi", ok"}';

  it('refuses in safe mode, since the reading is ambiguous', () => {
    expect(() => repairJson(input)).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('escapes the inner quotes as content in aggressive mode', () => {
    expect(repairJson(input, { mode: 'aggressive' })).toBe('{"a":"he said \\"hi\\", ok"}');
  });

  it('treats a literal double quote inside a non-standard delimiter as plain content', () => {
    // Because the string is single-quoted, an embedded '"' is never a delimiter
    // candidate, so it is always escaped as content regardless of mode.
    expect(repairJson(`{'a': 'he said "hi"'}`)).toBe('{"a":"he said \\"hi\\""}');
  });
});

describe('raw control characters inside a double-quoted string are escaped', () => {
  it('escapes a raw tab character', () => {
    const input = '{"a":"col1\tcol2"}';
    expect(repairJson(input)).toBe('{"a":"col1\\tcol2"}');
  });

  it('escapes a raw newline that is not treated as ending the string', () => {
    // With real content after it, the newline is preserved as escaped content
    // rather than being read as the (missing) end of the string.
    const input = '{"a":"line1\nline2 and more text"}';
    expect(repairJson(input)).toBe('{"a":"line1\\nline2 and more text"}');
  });

  it('escapes a raw control character that is not whitespace at all', () => {
    const input = '{"a":"x\u0001y"}';
    expect(repairJson(input)).toBe('{"a":"x\\u0001y"}');
  });
});

describe('invalid escape sequences are fixed without losing information', () => {
  it('preserves an unrecognized escape like \\x losslessly by doubling the backslash', () => {
    const input = String.raw`{"a":"\x41"}`;
    const output = repairJson(input);
    expect(output).toBe(String.raw`{"a":"\\x41"}`);
    expect(JSON.parse(output)).toEqual({ a: String.raw`\x41` });
  });

  it('drops a dangling backslash at the end of input', () => {
    const input = '"abc\\';
    expect(repairJson(input)).toBe('"abc"');
    const result = repairJson(input, { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['fixed-escape', 'terminated-string-at-eof']);
  });

  it('drops a truncated \\u escape that never reaches four hex digits before end of input', () => {
    const input = '"a\\u00';
    expect(repairJson(input)).toBe('"a"');
  });

  it('escapes an incomplete \\u sequence that is followed by more string content', () => {
    // Not enough hex digits, but the string does not end here, so the backslash
    // is preserved as an escaped literal rather than silently dropped.
    const input = String.raw`"a\u00zz"`;
    const output = repairJson(input);
    expect(JSON.parse(output)).toBe(String.raw`a\u00zz`);
  });

  it('unescapes a backslash-escaped double quote inside a single-quoted string', () => {
    const input = String.raw`{'a':'say \"hi\"'}`;
    const output = repairJson(input);
    expect(JSON.parse(output)).toEqual({ a: 'say "hi"' });
  });

  it('replaces a backslash before a raw control character', () => {
    const input = '"a\\\tb"';
    const output = repairJson(input);
    expect(JSON.parse(output)).toBe('a\tb');
  });

  it('keeps a valid \\uXXXX escape untouched', () => {
    const input = '"\\u0041"';
    expect(repairJson(input)).toBe(input);
  });
});

describe('lone surrogates are escaped so the output stays well-formed', () => {
  // A bare lone surrogate is, perhaps surprisingly, accepted by the native
  // `JSON.parse`, so a document containing only that defect takes the fast
  // path and is returned byte-identical. Pairing it with a trailing comma
  // forces the repairing parser to run so the escaping rule is exercised.
  it('escapes an unpaired high surrogate once another repair forces a full parse', () => {
    const input = '{"a":"x\ud800y",}';
    const output = repairJson(input);
    expect(output).toBe('{"a":"x\\ud800y"}');
  });

  it('escapes an unpaired low surrogate once another repair forces a full parse', () => {
    const input = '{"a":"x\udc00y",}';
    const output = repairJson(input);
    expect(output).toBe('{"a":"x\\udc00y"}');
  });

  it('keeps a bare unpaired surrogate untouched when it is the only defect', () => {
    // No other repair is needed, so the fast path wins and the lone surrogate
    // is left exactly as written, matching native JSON.parse behaviour.
    const input = '{"a":"x\ud800y"}';
    expect(repairJson(input)).toBe(input);
  });

  it('keeps a properly paired surrogate pair untouched', () => {
    const input = '{"a":"😀"}';
    expect(repairJson(input)).toBe(input);
  });
});

describe('allowSingleQuotes:false disables single-quote (and other non-standard delimiter) normalization', () => {
  it('fails on a single-quoted string when the flag is off', () => {
    expect(() => repairJson("{'a':'b'}", { allowSingleQuotes: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('fails on a backtick-quoted string when the flag is off', () => {
    expect(() => repairJson('{`a`:`b`}', { allowSingleQuotes: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('still repairs double-quoted content when the flag is off', () => {
    expect(repairJson('{"a":1,}', { allowSingleQuotes: false })).toBe('{"a":1}');
  });
});

describe('returnMetadata reports string repairs with type and location', () => {
  it('records normalized-quotes for a single-quoted string', () => {
    const result = repairJson("{'a':'b'}", { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['normalized-quotes', 'normalized-quotes']);
    expect(result.repairs[0]?.position).toBe(1);
  });

  it('records escaped-character for a raw control character', () => {
    const result = repairJson('{"a":"col1\tcol2"}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['escaped-character']);
  });

  it('records terminated-string-at-newline with a position pointing at the line break', () => {
    const input = '{"a": "value,\n "b": 2\n}';
    const result = repairJson(input, { returnMetadata: true });
    expect(result.repairs.some((r) => r.type === 'terminated-string-at-newline')).toBe(true);
    const repair = result.repairs.find((r) => r.type === 'terminated-string-at-newline');
    expect(repair?.position).toBe(input.indexOf('\n'));
    expect(repair?.line).toBe(1);
  });
});
