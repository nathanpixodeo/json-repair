import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('unambiguous number fixes are applied in safe mode', () => {
  const rows: [string, string][] = [
    ['{"a":+1}', '{"a":1}'],
    ['{"a":+1.5}', '{"a":1.5}'],
    ['{"a":.5}', '{"a":0.5}'],
    ['{"a":-.5}', '{"a":-0.5}'],
    ['{"a":5.}', '{"a":5}'],
    ['{"a":-5.}', '{"a":-5}'],
    ['{"a":1e}', '{"a":1}'],
    ['{"a":1e+}', '{"a":1}'],
    ['{"a":1E}', '{"a":1}'],
  ];

  for (const [input, expected] of rows) {
    it(`rewrites ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      expect(repairJson(input)).toBe(expected);
    });
  }

  it('applies the same fixes to a bare top-level number', () => {
    expect(repairJson('+1')).toBe('1');
    expect(repairJson('.5')).toBe('0.5');
    expect(repairJson('5.')).toBe('5');
  });

  it('applies the same fixes inside an array', () => {
    expect(repairJson('[+1,.5,5.,1e]')).toBe('[1,0.5,5,1]');
  });
});

describe('numbers that are already valid JSON are preserved exactly, byte for byte', () => {
  const numbers = [
    '0',
    '-0',
    '1.0',
    '1.50',
    '1e999',
    '-1e-999',
    '1E+10',
    '0.000001',
    '123456789012345678901234567890',
  ];

  for (const number of numbers) {
    it(`keeps "${number}" untouched even when a sibling needs repair`, () => {
      // The trailing comma forces the repairing parser to run; the number
      // itself must still come out with every digit exactly as written.
      const input = `{"a":${number},}`;
      expect(repairJson(input)).toBe(`{"a":${number}}`);
    });
  }
});

describe('digit separators are only accepted in aggressive mode', () => {
  it('refuses a digit-separated number in safe mode', () => {
    expect(() => repairJson('{"a":1_000}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('strips the underscores in aggressive mode', () => {
    expect(repairJson('{"a":1_000}', { mode: 'aggressive' })).toBe('{"a":1000}');
  });

  it('strips underscores from a fractional number in aggressive mode', () => {
    expect(repairJson('{"a":1_000.5_5}', { mode: 'aggressive' })).toBe('{"a":1000.55}');
  });
});

describe('leading zeros are only accepted in aggressive mode', () => {
  it('refuses a leading-zero number in safe mode', () => {
    expect(() => repairJson('{"a":007}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('strips the leading zeros in aggressive mode', () => {
    expect(repairJson('{"a":007}', { mode: 'aggressive' })).toBe('{"a":7}');
  });

  it('strips leading zeros from a negative number in aggressive mode', () => {
    expect(repairJson('{"a":-007}', { mode: 'aggressive' })).toBe('{"a":-7}');
  });

  it('reduces an all-zero leading run down to a single digit', () => {
    expect(repairJson('{"a":00}', { mode: 'aggressive' })).toBe('{"a":0}');
  });
});

describe('hexadecimal numbers are only accepted in aggressive mode', () => {
  it('refuses a hex literal in safe mode', () => {
    expect(() => repairJson('{"a":0x1F}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('converts a hex literal to decimal in aggressive mode', () => {
    expect(repairJson('{"a":0x1F}', { mode: 'aggressive' })).toBe('{"a":31}');
  });

  it('converts an upper-case hex prefix and digits in aggressive mode', () => {
    expect(repairJson('{"a":0X1f}', { mode: 'aggressive' })).toBe('{"a":31}');
  });

  it('converts a negative hex literal in aggressive mode', () => {
    expect(repairJson('{"a":-0xFF}', { mode: 'aggressive' })).toBe('{"a":-255}');
  });

  it('preserves full precision for a hex literal above Number.MAX_SAFE_INTEGER', () => {
    expect(repairJson('{"a":0xFFFFFFFFFFFFFFFF}', { mode: 'aggressive' })).toBe(
      '{"a":18446744073709551615}',
    );
  });
});

describe('a token that is not a number in any mode falls back to unquoted-value handling', () => {
  it('refuses a malformed numeric-looking token in safe mode', () => {
    expect(() => repairJson('{"a":1.2.3}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('quotes a malformed numeric-looking token as a string in aggressive mode', () => {
    expect(repairJson('{"a":1.2.3}', { mode: 'aggressive' })).toBe('{"a":"1.2.3"}');
  });
});

describe('returnMetadata reports number repairs with type and location', () => {
  it('records normalized-number for a leading plus sign', () => {
    const result = repairJson('{"a":+1}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['normalized-number']);
    expect(result.repairs[0]?.position).toBe('{"a":'.length);
  });

  it('records normalized-number for a hex literal in aggressive mode', () => {
    const result = repairJson('{"a":0x1F}', { mode: 'aggressive', returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['normalized-number']);
  });
});
