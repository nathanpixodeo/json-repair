import { describe, expect, it } from 'vitest';

import { extractAllJson, extractJson, parseJson, repairJson } from '../../src/index.js';

describe('SRS 6 rules table', () => {
  const rows: [string, string][] = [
    ['{"name":"John",}', '{"name":"John"}'],
    ['[1,2,3,]', '[1,2,3]'],
    ["{'name':'John'}", '{"name":"John"}'],
    ['{name:"John"}', '{"name":"John"}'],
    ['```json\n{"a":1}\n```', '{"a":1}'],
    ['Here:\n{"a":1}\nDone.', '{"a":1}'],
    ['{"users":[1,2,3', '{"users":[1,2,3]}'],
  ];

  for (const [input, expected] of rows) {
    it(JSON.stringify(input), () => {
      expect(repairJson(input)).toBe(expected);
    });
  }
});

describe('core behaviour', () => {
  it('returns valid JSON byte-identical', () => {
    const input = '{\n  "a": 1,\n  "b": [1, 2]\n}';
    expect(repairJson(input)).toBe(input);
    expect(repairJson(input, { returnMetadata: true })).toEqual({
      json: input,
      changed: false,
      repairs: [],
    });
  });

  it('parses to a value', () => {
    expect(parseJson<{ a: number }>('{a:1,}')).toEqual({ a: 1 });
  });

  it('extracts verbatim', () => {
    expect(extractJson('Here: {"a": 1} done.')).toBe('{"a": 1}');
    expect(extractAllJson('a {"a":1} b [2] c')).toEqual(['{"a":1}', '[2]']);
  });

  it('prefers real JSON over prose decoys', () => {
    expect(repairJson('[2024-01-01 12:00:00] {"level":"info"}')).toBe('{"level":"info"}');
  });

  it('handles unterminated strings at a newline', () => {
    expect(repairJson('{"a": "value,\n "b": 2\n}')).toBe('{"a":"value,","b":2}');
  });

  it('keeps inner quotes as content in aggressive mode', () => {
    expect(repairJson('{"a": "he said "hi", ok"}', { mode: 'aggressive' })).toBe(
      '{"a":"he said \\"hi\\", ok"}',
    );
  });

  it('refuses inner double quotes in safe mode', () => {
    expect(() => repairJson('{"a": "he said "hi", ok"}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('keeps apostrophes inside single-quoted strings in safe mode', () => {
    expect(repairJson("{'a': 'it's fine', 'b': 2}")).toBe('{"a":"it\'s fine","b":2}');
  });

  it('closes truncated containers', () => {
    expect(repairJson('{"a":{"b":[1,2')).toBe('{"a":{"b":[1,2]}}');
  });

  it('drops a truncated final member', () => {
    expect(repairJson('{"a":1,"b')).toBe('{"a":1}');
  });

  it('normalises python literals in safe mode, but not lossy ones', () => {
    expect(repairJson('{"a":True,"b":None}')).toBe('{"a":true,"b":null}');
    expect(repairJson('{"a":True}')).toBe('{"a":true}');
    expect(() => repairJson('{"a":NaN}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
    expect(repairJson('{"a":NaN}', { mode: 'aggressive' })).toBe('{"a":null}');
  });

  it('enforces limits', () => {
    expect(() => repairJson('{"a":1}', { maxLength: 3 })).toThrowError(
      expect.objectContaining({ code: 'MAX_LENGTH_EXCEEDED' }),
    );
    expect(() => repairJson('[[[[1]]]]', { maxDepth: 2 })).toThrowError(
      expect.objectContaining({ code: 'MAX_DEPTH_EXCEEDED' }),
    );
    expect(() => repairJson('{"a":1,}', { maxRepairs: 0 })).toThrowError(
      expect.objectContaining({ code: 'MAX_REPAIRS_EXCEEDED' }),
    );
    expect(() => repairJson('no json here')).toThrowError(
      expect.objectContaining({ code: 'NO_JSON_FOUND' }),
    );
    expect(() => repairJson(42 as unknown as string)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  });

  it('stays linear on quote-heavy input', () => {
    const input = `{"a":"${'"'.repeat(50_000)}"}`;
    const started = Date.now();
    expect(() => repairJson(input, { mode: 'aggressive' })).not.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('handles a deeply nested valid document without overflowing', () => {
    const input = `${'['.repeat(500)}1${']'.repeat(500)}`;
    expect(repairJson(input)).toBe(input);
    expect(repairJson(input.slice(0, 501))).toBe(input);
  });

  it('keeps number literals verbatim', () => {
    expect(repairJson('{"a":1.0,"b":1e999,}')).toBe('{"a":1.0,"b":1e999}');
  });

  it('strips comments', () => {
    expect(repairJson('{ // hi\n "a": 1 /* x */ }')).toBe('{"a":1}');
  });

  it('reports metadata', () => {
    const result = repairJson('﻿{a:1,}', { returnMetadata: true });
    expect(result.changed).toBe(true);
    expect(result.repairs.map((r) => r.type)).toEqual([
      'removed-byte-order-mark',
      'quoted-key',
      'removed-trailing-comma',
    ]);
  });
});
