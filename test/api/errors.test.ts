import { describe, expect, it } from 'vitest';

import {
  extractJson,
  isJsonRepairError,
  repairJson,
  type JsonRepairErrorCode,
} from '../../src/index.js';

/**
 * Coverage for every `JsonRepairErrorCode` reachable through the public API,
 * plus the shape guarantees every thrown error carries: it is a real `Error`
 * subclass named `JsonRepairError`, `isJsonRepairError` recognises it (and
 * rejects a plain `Error`), and the positional fields (`position`, `line`,
 * `column`, `snippet`) are present exactly where the engine actually
 * populates them and are sane when they are.
 *
 * The exact shape of each code's positional fields was verified empirically
 * against the running library, not assumed: `MAX_LENGTH_EXCEEDED` is thrown
 * before any scanning happens and therefore carries only `position`, while
 * `NO_JSON_FOUND`, `UNREPAIRABLE_JSON`, `AMBIGUOUS_REPAIR` and
 * `MAX_DEPTH_EXCEEDED` / `MAX_REPAIRS_EXCEEDED` all carry the full
 * `position` / `line` / `column` / `snippet` quartet, and `INVALID_INPUT`
 * carries none of them since it fires before there is any source to locate.
 */

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected fn to throw');
}

function expectCommonShape(error: unknown, code: JsonRepairErrorCode): void {
  expect(error).toBeInstanceOf(Error);
  expect(isJsonRepairError(error)).toBe(true);
  const err = error as Error & { code: JsonRepairErrorCode };
  expect(err.name).toBe('JsonRepairError');
  expect(err.code).toBe(code);
}

describe('isJsonRepairError', () => {
  it('recognises a real JsonRepairError', () => {
    const error = captureError(() => repairJson('not json at all'));
    expect(isJsonRepairError(error)).toBe(true);
  });

  it('rejects a plain Error', () => {
    expect(isJsonRepairError(new Error('x'))).toBe(false);
  });

  it('rejects non-error values', () => {
    expect(isJsonRepairError(undefined)).toBe(false);
    expect(isJsonRepairError(null)).toBe(false);
    expect(isJsonRepairError('AMBIGUOUS_REPAIR')).toBe(false);
    expect(isJsonRepairError({ code: 'AMBIGUOUS_REPAIR' })).toBe(false);
  });
});

describe('INVALID_INPUT', () => {
  it('is thrown for non-string input, with no positional fields', () => {
    const error = captureError(() => repairJson(42 as unknown as string));
    expectCommonShape(error, 'INVALID_INPUT');
    const err = error as Error & {
      position?: number;
      line?: number;
      column?: number;
      snippet?: string;
    };
    expect(err.message).toContain('must be a string');
    expect(err.position).toBeUndefined();
    expect(err.line).toBeUndefined();
    expect(err.column).toBeUndefined();
    expect(err.snippet).toBeUndefined();
  });

  it('is thrown for an invalid option, naming the offending option', () => {
    const error = captureError(() => repairJson('{"a":1}', { mode: 'BOGUS' as never }));
    expectCommonShape(error, 'INVALID_INPUT');
    expect((error as Error).message).toContain('"mode"');
  });

  it('is thrown for a non-object options bag', () => {
    const error = captureError(() => repairJson('{"a":1}', 42 as never));
    expectCommonShape(error, 'INVALID_INPUT');
  });

  it('is thrown for an invalid select strategy via extractJson', () => {
    const error = captureError(() => extractJson('{"a":1}', { select: 'BOGUS' as never }));
    expectCommonShape(error, 'INVALID_INPUT');
    expect((error as Error).message).toContain('"select"');
  });
});

describe('NO_JSON_FOUND', () => {
  it('is thrown when no candidate JSON value exists in the input, with a full location', () => {
    const input = 'totally not json';
    const error = captureError(() => repairJson(input));
    expectCommonShape(error, 'NO_JSON_FOUND');
    const err = error as Error & {
      position: number;
      line: number;
      column: number;
      snippet: string;
    };
    expect(err.position).toBe(0);
    expect(err.line).toBe(1);
    expect(err.column).toBe(1);
    expect(err.snippet).toBe(input);
  });
});

describe('UNREPAIRABLE_JSON', () => {
  it('is thrown when a disabled flag makes a construct impossible to repair, with a full location', () => {
    const input = "{'a':1}";
    const error = captureError(() =>
      repairJson(input, { mode: 'aggressive', allowSingleQuotes: false }),
    );
    expectCommonShape(error, 'UNREPAIRABLE_JSON');
    const err = error as Error & {
      position: number;
      line: number;
      column: number;
      snippet: string;
    };
    expect(err.position).toBeGreaterThanOrEqual(0);
    expect(err.position).toBeLessThanOrEqual(input.length);
    expect(err.line).toBe(1);
    expect(err.column).toBeGreaterThan(0);
    expect(err.snippet.length).toBeGreaterThan(0);
  });
});

describe('AMBIGUOUS_REPAIR', () => {
  it('is thrown in safe mode when a repair would require guessing, with a full location', () => {
    const input = '{"a": "he said "hi", ok"}';
    const error = captureError(() => repairJson(input));
    expectCommonShape(error, 'AMBIGUOUS_REPAIR');
    const err = error as Error & {
      position: number;
      line: number;
      column: number;
      snippet: string;
    };
    expect(err.message).toContain('mode: "aggressive"');
    expect(err.position).toBeGreaterThanOrEqual(0);
    expect(err.position).toBeLessThanOrEqual(input.length);
    expect(err.line).toBe(1);
    expect(err.column).toBeGreaterThan(0);
    expect(err.snippet.length).toBeGreaterThan(0);
  });

  it('is avoided in aggressive mode, which resolves the same input', () => {
    const input = '{"a": "he said "hi", ok"}';
    expect(() => repairJson(input, { mode: 'aggressive' })).not.toThrow();
  });
});

describe('MAX_LENGTH_EXCEEDED', () => {
  it('is thrown before scanning, carrying only position', () => {
    const error = captureError(() => repairJson('{"a":1}', { maxLength: 3 }));
    expectCommonShape(error, 'MAX_LENGTH_EXCEEDED');
    const err = error as Error & {
      position?: number;
      line?: number;
      column?: number;
      snippet?: string;
    };
    expect(err.position).toBe(3);
    expect(err.line).toBeUndefined();
    expect(err.column).toBeUndefined();
    expect(err.snippet).toBeUndefined();
  });
});

describe('MAX_DEPTH_EXCEEDED', () => {
  it('is thrown with a full location at the point nesting exceeded the limit', () => {
    const input = '[[[[1]]]]';
    const error = captureError(() => repairJson(input, { maxDepth: 2 }));
    expectCommonShape(error, 'MAX_DEPTH_EXCEEDED');
    const err = error as Error & {
      position: number;
      line: number;
      column: number;
      snippet: string;
    };
    expect(err.position).toBeGreaterThanOrEqual(0);
    expect(err.position).toBeLessThanOrEqual(input.length);
    expect(err.line).toBe(1);
    expect(err.column).toBeGreaterThan(0);
    expect(err.snippet.length).toBeGreaterThan(0);
  });
});

describe('MAX_REPAIRS_EXCEEDED', () => {
  it('is thrown with a full location once the repair budget is spent', () => {
    const input = '{"a":1,}';
    const error = captureError(() => repairJson(input, { maxRepairs: 0 }));
    expectCommonShape(error, 'MAX_REPAIRS_EXCEEDED');
    const err = error as Error & {
      position: number;
      line: number;
      column: number;
      snippet: string;
    };
    expect(err.message).toContain('0');
    expect(err.position).toBeGreaterThanOrEqual(0);
    expect(err.position).toBeLessThanOrEqual(input.length);
    expect(err.line).toBe(1);
    expect(err.column).toBeGreaterThan(0);
    expect(err.snippet.length).toBeGreaterThan(0);
  });
});
