import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('mandatory SRS table row involving a missing closing bracket', () => {
  it('closes a truncated object containing a truncated array', () => {
    expect(repairJson('{"users":[1,2,3')).toBe('{"users":[1,2,3]}');
  });
});

describe('missing closing brackets are added at the end of input', () => {
  it('closes a truncated object', () => {
    expect(repairJson('{"a":1')).toBe('{"a":1}');
  });

  it('closes a truncated array', () => {
    expect(repairJson('[1,2,3')).toBe('[1,2,3]');
  });

  it('closes an empty truncated object', () => {
    expect(repairJson('{')).toBe('{}');
  });

  it('closes an empty truncated array', () => {
    expect(repairJson('[')).toBe('[]');
  });

  it('closes doubly nested truncated containers, innermost first', () => {
    expect(repairJson('{"a":{"b":[1,2')).toBe('{"a":{"b":[1,2]}}');
  });

  it('closes an array of truncated objects', () => {
    expect(repairJson('[{"a":1},{"b":2')).toBe('[{"a":1},{"b":2}]');
  });

  it('closes several levels of nesting opened but never closed', () => {
    expect(repairJson('{"a":[{"b":{"c":[1,2,3')).toBe('{"a":[{"b":{"c":[1,2,3]}}]}');
  });

  it('closes a truncated array of arrays', () => {
    expect(repairJson('[[1,2],[3,4')).toBe('[[1,2],[3,4]]');
  });
});

describe('content left over after a complete top-level value is dropped', () => {
  it('drops an extra closing brace after a complete object', () => {
    expect(repairJson('{"a":1}}')).toBe('{"a":1}');
  });

  it('drops an extra closing bracket after a complete array', () => {
    expect(repairJson('[1,2,3]]')).toBe('[1,2,3]');
  });

  it('drops a mismatched closer left over after a complete object', () => {
    expect(repairJson('{"a":1}]')).toBe('{"a":1}');
  });
});

describe('a mismatched closing bracket that is the last content in the input is safely dropped', () => {
  it('drops a stray "]" inside an unclosed object when it is the final character', () => {
    // The "]" has no open array to match, and it sits at the very end of the
    // content, so the parser treats it as a typo for the object's own closer.
    expect(repairJson('{"a":1]')).toBe('{"a":1}');
  });

  it('drops a stray "}" inside an unclosed array when it is the final character', () => {
    expect(repairJson('[1,2}')).toBe('[1,2]');
  });
});

describe('a mismatched closing bracket elsewhere requires aggressive mode', () => {
  it('refuses a mismatched closer that is not the last content in safe mode', () => {
    expect(() => repairJson('[1,}2]')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('refuses a mismatched closer immediately before the real one in safe mode', () => {
    expect(() => repairJson('{"a":1]}')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('drops the mismatched closer in aggressive mode and keeps parsing', () => {
    expect(repairJson('[1,}2]', { mode: 'aggressive' })).toBe('[1,2]');
    expect(repairJson('{"a":1]}', { mode: 'aggressive' })).toBe('{"a":1}');
  });
});

describe('a truncated final member is dropped rather than left dangling', () => {
  it('drops a truncated final key with no value at all', () => {
    expect(repairJson('{"a":1,"b')).toBe('{"a":1}');
  });

  it('drops a truncated final key inside a nested object', () => {
    expect(repairJson('{"a":{"b":1,"c')).toBe('{"a":{"b":1}}');
  });

  it('drops a truncated key that has no value and no colon', () => {
    expect(repairJson('{"a":1,"trailingKey"')).toBe('{"a":1}');
  });
});

describe('fixMissingBrackets:false disables bracket repair', () => {
  it('fails to close a truncated object when the flag is off', () => {
    expect(() => repairJson('{"a":1', { fixMissingBrackets: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('fails to close a truncated array when the flag is off', () => {
    expect(() => repairJson('[1,2,3', { fixMissingBrackets: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });
});

describe('returnMetadata reports bracket repairs with type and location', () => {
  it('records added-closing-brace for a truncated object', () => {
    const result = repairJson('{"a":1', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['added-closing-brace']);
    expect(result.repairs[0]?.line).toBe(1);
    expect(typeof result.repairs[0]?.position).toBe('number');
  });

  it('records added-closing-bracket for a truncated array', () => {
    const result = repairJson('[1,2,3', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['added-closing-bracket']);
  });

  it('records closing repairs innermost-first for nested truncation', () => {
    const result = repairJson('{"a":{"b":[1,2', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual([
      'added-closing-bracket',
      'added-closing-brace',
      'added-closing-brace',
    ]);
  });

  it('records removed-trailing-content for a stray closer left after a complete value', () => {
    const result = repairJson('{"a":1}}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['removed-trailing-content']);
  });

  it('records removed-stray-token followed by added-closing-brace for a mismatched final closer', () => {
    const result = repairJson('{"a":1]', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual([
      'removed-stray-token',
      'added-closing-brace',
    ]);
  });

  it('records removed-incomplete-member followed by added-closing-brace for a dropped truncated final member', () => {
    const result = repairJson('{"a":1,"b', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual([
      'removed-incomplete-member',
      'added-closing-brace',
    ]);
  });
});
