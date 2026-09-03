import { describe, expect, it } from 'vitest';

import { extractJson, parseJson, repairJson } from '../../src/index.js';
import { MAX_SUPPORTED_DEPTH } from '../../src/index.js';

describe('maxLength enforcement', () => {
  it('throws MAX_LENGTH_EXCEEDED when the input is one character over the limit', () => {
    const input = '{"a":1}';
    expect(() => repairJson(input, { maxLength: input.length - 1 })).toThrowError(
      expect.objectContaining({ code: 'MAX_LENGTH_EXCEEDED' }),
    );
  });

  it('succeeds when the input length exactly equals the limit', () => {
    const input = '{"a":1}';
    expect(repairJson(input, { maxLength: input.length })).toBe(input);
  });

  it('applies the same boundary to parseJson', () => {
    const input = '{"a":1}';
    expect(() => parseJson(input, { maxLength: input.length - 1 })).toThrowError(
      expect.objectContaining({ code: 'MAX_LENGTH_EXCEEDED' }),
    );
    expect(parseJson(input, { maxLength: input.length })).toEqual({ a: 1 });
  });
});

describe('maxDepth enforcement on already-valid documents (fast path)', () => {
  it('accepts a valid document nested exactly to the default maxDepth of 512', () => {
    const input = `${'['.repeat(512)}1${']'.repeat(512)}`;
    expect(repairJson(input)).toBe(input);
  });

  it('throws MAX_DEPTH_EXCEEDED for a valid document nested one level past the default maxDepth', () => {
    const input = `${'['.repeat(513)}1${']'.repeat(513)}`;
    expect(() => repairJson(input)).toThrowError(
      expect.objectContaining({ code: 'MAX_DEPTH_EXCEEDED' }),
    );
  });

  it('accepts a valid document nested exactly to an explicit maxDepth', () => {
    const input = `${'['.repeat(MAX_SUPPORTED_DEPTH)}1${']'.repeat(MAX_SUPPORTED_DEPTH)}`;
    expect(repairJson(input, { maxDepth: MAX_SUPPORTED_DEPTH })).toBe(input);
  });

  it('throws MAX_DEPTH_EXCEEDED for a valid document nested one level past an explicit maxDepth', () => {
    const input = `${'['.repeat(MAX_SUPPORTED_DEPTH + 1)}1${']'.repeat(MAX_SUPPORTED_DEPTH + 1)}`;
    expect(() => repairJson(input, { maxDepth: MAX_SUPPORTED_DEPTH })).toThrowError(
      expect.objectContaining({ code: 'MAX_DEPTH_EXCEEDED' }),
    );
  });
});

describe('maxDepth enforcement on malformed documents (recursive-parser path)', () => {
  // These documents are missing their closing brackets, so they never reach
  // native JSON.parse successfully and instead go through the recursive
  // parser's own depth tracking (RepairContext.enter), a different code path
  // from the fast-path check above.
  //
  // extract: false is used deliberately. With extraction enabled, the engine
  // may retry parsing starting one character later when the first attempt
  // hits a limit; for an unclosed run of "[" that shifted attempt has one
  // less level of nesting and can therefore succeed, masking the very depth
  // violation this test targets. Disabling extraction pins the parse to
  // start at offset 0, so the depth violation is unavoidable.
  it('accepts a malformed document nested exactly to the default maxDepth', () => {
    const input = '['.repeat(512);
    expect(() => repairJson(input, { extract: false })).not.toThrow();
  });

  it('throws MAX_DEPTH_EXCEEDED for a malformed document nested one level past the default maxDepth, safe mode', () => {
    const input = '['.repeat(513);
    expect(() => repairJson(input, { extract: false })).toThrowError(
      expect.objectContaining({ code: 'MAX_DEPTH_EXCEEDED' }),
    );
  });

  it('throws MAX_DEPTH_EXCEEDED for a malformed document nested one level past the default maxDepth, aggressive mode', () => {
    const input = '['.repeat(513);
    expect(() => repairJson(input, { extract: false, mode: 'aggressive' })).toThrowError(
      expect.objectContaining({ code: 'MAX_DEPTH_EXCEEDED' }),
    );
  });

  it('throws MAX_DEPTH_EXCEEDED for a malformed document nested one level past an explicit maxDepth', () => {
    const input = '['.repeat(MAX_SUPPORTED_DEPTH + 1);
    expect(() => repairJson(input, { extract: false, maxDepth: MAX_SUPPORTED_DEPTH })).toThrowError(
      expect.objectContaining({ code: 'MAX_DEPTH_EXCEEDED' }),
    );
  });
});

describe('maxRepairs enforcement', () => {
  it('throws MAX_REPAIRS_EXCEEDED when maxRepairs is 0 and the input needs one repair', () => {
    expect(() => repairJson('{"a":1,}', { maxRepairs: 0 })).toThrowError(
      expect.objectContaining({ code: 'MAX_REPAIRS_EXCEEDED' }),
    );
  });

  it('throws MAX_REPAIRS_EXCEEDED when the repair count exceeds a positive maxRepairs', () => {
    // Unquoted key plus trailing comma is two repairs; maxRepairs: 1 is one too few.
    expect(() => repairJson('{a:1,}', { maxRepairs: 1 })).toThrowError(
      expect.objectContaining({ code: 'MAX_REPAIRS_EXCEEDED' }),
    );
  });

  it('succeeds when maxRepairs exactly equals the number of repairs needed', () => {
    const result = repairJson('{a:1,}', { maxRepairs: 2, returnMetadata: true });
    expect(result.repairs).toHaveLength(2);
    expect(result.json).toBe('{"a":1}');
  });

  it('counts extraction and trailing-content removal against maxRepairs', () => {
    // The JSON itself is perfectly valid, so the parser records nothing; the
    // two repairs come entirely from isolating it out of the surrounding
    // prose. They must still be budgeted.
    expect(() => repairJson('Here: {"a":1} done', { maxRepairs: 1 })).toThrowError(
      expect.objectContaining({ code: 'MAX_REPAIRS_EXCEEDED' }),
    );

    const result = repairJson('Here: {"a":1} done', { maxRepairs: 2, returnMetadata: true });
    expect(result.json).toBe('{"a":1}');
    expect(result.repairs.map((repair) => repair.type)).toEqual([
      'extracted-json',
      'removed-trailing-content',
    ]);
  });

  it('counts removing a byte order mark against maxRepairs on the fast path', () => {
    // A leading BOM in front of otherwise valid JSON never reaches the
    // repairing parser, so this budget check lives on the fast path.
    expect(() => repairJson('﻿{"a":1}', { maxRepairs: 0 })).toThrowError(
      expect.objectContaining({ code: 'MAX_REPAIRS_EXCEEDED' }),
    );

    const result = repairJson('﻿{"a":1}', { maxRepairs: 1, returnMetadata: true });
    expect(result.json).toBe('{"a":1}');
    expect(result.repairs.map((repair) => repair.type)).toEqual(['removed-byte-order-mark']);
  });
});

describe('option validation', () => {
  it('throws INVALID_INPUT when options is not an object', () => {
    expect(() => repairJson('{"a":1}', 'not-an-object' as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('throws INVALID_INPUT when options is null', () => {
    expect(() => repairJson('{"a":1}', null as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('throws INVALID_INPUT for an unrecognized mode', () => {
    expect(() => repairJson('{"a":1}', { mode: 'yolo' as never })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('throws INVALID_INPUT for a non-boolean flag', () => {
    expect(() => repairJson('{"a":1}', { allowComments: 'yes' as never })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('throws INVALID_INPUT for a non-integer limit', () => {
    expect(() => repairJson('{"a":1}', { maxLength: 1.5 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('throws INVALID_INPUT for a negative limit', () => {
    expect(() => repairJson('{"a":1}', { maxLength: -1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() => repairJson('{"a":1}', { maxDepth: -1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
    expect(() => repairJson('{"a":1}', { maxRepairs: -1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('throws INVALID_INPUT when maxDepth is set above MAX_SUPPORTED_DEPTH', () => {
    expect(() => repairJson('{"a":1}', { maxDepth: MAX_SUPPORTED_DEPTH + 1 })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('accepts maxDepth set exactly to MAX_SUPPORTED_DEPTH', () => {
    expect(() => repairJson('{"a":1}', { maxDepth: MAX_SUPPORTED_DEPTH })).not.toThrow();
  });

  it('throws INVALID_INPUT for an unrecognized select value on extractJson', () => {
    expect(() => extractJson('{"a":1}', { select: 'random' as never })).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });
});

describe('input type validation', () => {
  const nonStringInputs: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a plain object', { a: 1 }],
    ['an array', [1, 2, 3]],
    ['a Symbol', Symbol('not json')],
  ];

  for (const [label, value] of nonStringInputs) {
    it(`throws INVALID_INPUT for ${label} passed as input`, () => {
      expect(() => repairJson(value as never)).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT' }),
      );
    });
  }

  it('throws NO_JSON_FOUND for an empty string', () => {
    expect(() => repairJson('')).toThrowError(expect.objectContaining({ code: 'NO_JSON_FOUND' }));
  });

  it('throws NO_JSON_FOUND for a whitespace-only string', () => {
    expect(() => repairJson('   \n\t  \r\n  ')).toThrowError(
      expect.objectContaining({ code: 'NO_JSON_FOUND' }),
    );
  });
});
