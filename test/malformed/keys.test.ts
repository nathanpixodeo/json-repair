import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('mandatory SRS table rows involving keys and extraction', () => {
  it('quotes an unquoted identifier key', () => {
    expect(repairJson('{name:"John"}')).toBe('{"name":"John"}');
  });

  it('extracts JSON from a tagged fenced code block', () => {
    expect(repairJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts JSON embedded in surrounding prose', () => {
    expect(repairJson('Here:\n{"a":1}\nDone.')).toBe('{"a":1}');
  });
});

describe('unquoted identifier keys are always safely quoted', () => {
  it('quotes a simple identifier key', () => {
    expect(repairJson('{a:1}')).toBe('{"a":1}');
  });

  it('quotes an identifier key containing an underscore and digits', () => {
    expect(repairJson('{user_1:1}')).toBe('{"user_1":1}');
  });

  it('quotes an identifier key starting with a dollar sign', () => {
    expect(repairJson('{$id:1}')).toBe('{"$id":1}');
  });

  it('quotes an identifier key starting with an underscore', () => {
    expect(repairJson('{_private:1}')).toBe('{"_private":1}');
  });

  it('quotes a non-English identifier key', () => {
    expect(repairJson('{café:1}')).toBe('{"café":1}');
  });

  it('quotes several unquoted keys in the same object', () => {
    expect(repairJson('{a:1,b:2,c:3}')).toBe('{"a":1,"b":2,"c":3}');
  });

  it('quotes unquoted keys inside a nested object', () => {
    expect(repairJson('{a:{b:{c:1}}}')).toBe('{"a":{"b":{"c":1}}}');
  });

  it('mixes quoted and unquoted keys in the same object', () => {
    expect(repairJson('{a:1,"b":2}')).toBe('{"a":1,"b":2}');
  });
});

describe('non-identifier unquoted keys require aggressive mode', () => {
  // A key that does not start with an identifier character cannot be read at
  // all in safe mode: there is no unquoted-key repair to fall back to, so this
  // is a hard failure rather than a refused-but-otherwise-valid reading.
  it('fails on a key starting with a digit in safe mode', () => {
    expect(() => repairJson('{2fast:1}')).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('quotes a key starting with a digit in aggressive mode', () => {
    expect(repairJson('{2fast:1}', { mode: 'aggressive' })).toBe('{"2fast":1}');
  });

  it('fails on a key starting with a symbol in safe mode', () => {
    expect(() => repairJson('{!bang:1}')).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('quotes a key starting with a symbol in aggressive mode', () => {
    expect(repairJson('{!bang:1}', { mode: 'aggressive' })).toBe('{"!bang":1}');
  });
});

describe('a missing colon between key and value is always inserted', () => {
  it('inserts the colon when a quoted key is directly followed by a value', () => {
    expect(repairJson('{"a" 1}')).toBe('{"a":1}');
  });

  it('inserts the colon when an unquoted key is directly followed by a value', () => {
    expect(repairJson('{a 1}')).toBe('{"a":1}');
  });

  it('inserts the colon across several members', () => {
    expect(repairJson('{"a" 1, "b" 2}')).toBe('{"a":1,"b":2}');
  });
});

describe('a key followed directly by another quote is ambiguous outside aggressive mode', () => {
  const input = '{"a" "b"}';

  it('refuses in safe mode, since a missing colon and a missing comma both read', () => {
    expect(() => repairJson(input)).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('absorbs the second quote as string content in aggressive mode, rather than splitting the reading', () => {
    // In aggressive mode the continuation probe looks past the first quote for
    // something that plausibly follows a key (a colon); since none is in
    // sight, both inner quotes are kept as escaped content and the object
    // closer immediately after is read as "key with a missing value".
    expect(repairJson(input, { mode: 'aggressive' })).toBe('{"a\\" \\"b":null}');
  });
});

describe('a key with no value at all requires aggressive mode', () => {
  it('refuses a key immediately followed by the closing brace in safe mode', () => {
    expect(() => repairJson('{"a"}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('inserts a null value in aggressive mode', () => {
    expect(repairJson('{"a"}', { mode: 'aggressive' })).toBe('{"a":null}');
  });

  it('refuses a key with no value before the next member in safe mode', () => {
    expect(() => repairJson('{"a","b":2}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('inserts a null value for the empty member in aggressive mode', () => {
    expect(repairJson('{"a","b":2}', { mode: 'aggressive' })).toBe('{"a":null,"b":2}');
  });
});

describe('allowUnquotedKeys:false disables unquoted key support entirely', () => {
  it('fails on an unquoted identifier key when the flag is off', () => {
    expect(() => repairJson('{a:1}', { allowUnquotedKeys: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('drops the unrecognizable key material as stray tokens in aggressive mode instead of failing', () => {
    // Aggressive mode's general-purpose "discard what cannot be parsed"
    // fallback is not gated by allowUnquotedKeys, so rather than erroring it
    // discards every character it cannot read as a key, leaving an empty
    // object.
    const result = repairJson('{a:1}', {
      allowUnquotedKeys: false,
      mode: 'aggressive',
      returnMetadata: true,
    });
    expect(result.json).toBe('{}');
    expect(result.repairs.every((r) => r.type === 'removed-stray-token')).toBe(true);
  });

  it('still repairs a quoted-key document when the flag is off', () => {
    expect(repairJson('{"a":1,}', { allowUnquotedKeys: false })).toBe('{"a":1}');
  });
});

describe('JSON embedded in a larger document is extracted', () => {
  it('extracts from an untagged fenced code block', () => {
    expect(repairJson('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts from prose that both precedes and follows the JSON', () => {
    expect(repairJson('The result was {"a":1} as expected.')).toBe('{"a":1}');
  });

  it('extracts an array from surrounding prose', () => {
    expect(repairJson('Values: [1,2,3] end')).toBe('[1,2,3]');
  });

  it('extracts JSON that itself needs repair', () => {
    expect(repairJson('Here is the data: {a:1,}')).toBe('{"a":1}');
  });
});

describe('returnMetadata reports key repairs with type and location', () => {
  it('records quoted-key for an unquoted identifier key', () => {
    const result = repairJson('{a:1}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['quoted-key']);
    expect(result.repairs[0]?.position).toBe(1);
  });

  it('records added-missing-colon for a key directly followed by a value', () => {
    const result = repairJson('{"a" 1}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['added-missing-colon']);
  });

  it('records extracted-json for content pulled out of surrounding prose', () => {
    const result = repairJson('Here:\n{"a":1}\nDone.', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual([
      'extracted-json',
      'removed-trailing-content',
    ]);
  });
});
