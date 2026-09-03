import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('mandatory SRS table rows involving commas', () => {
  it('drops a trailing comma before an object closing brace', () => {
    expect(repairJson('{"name":"John",}')).toBe('{"name":"John"}');
  });

  it('drops a trailing comma before an array closing bracket', () => {
    expect(repairJson('[1,2,3,]')).toBe('[1,2,3]');
  });
});

describe('trailing commas are removed in safe mode', () => {
  it('removes a trailing comma in an object', () => {
    expect(repairJson('{"a":1,}')).toBe('{"a":1}');
  });

  it('removes a trailing comma in an array', () => {
    expect(repairJson('[1,2,]')).toBe('[1,2]');
  });

  it('removes a trailing comma in a nested object', () => {
    expect(repairJson('{"a":{"b":1,},}')).toBe('{"a":{"b":1}}');
  });

  it('removes a trailing comma in a nested array', () => {
    expect(repairJson('[[1,2,],[3,4,],]')).toBe('[[1,2],[3,4]]');
  });

  it('removes a trailing comma in an array nested inside an object', () => {
    expect(repairJson('{"a":[1,2,3,],}')).toBe('{"a":[1,2,3]}');
  });

  it('removes trailing commas at every level of a deeply nested document', () => {
    expect(repairJson('{"a":{"b":{"c":[1,2,],},},}')).toBe('{"a":{"b":{"c":[1,2]}}}');
  });
});

describe('leading and repeated commas in objects are always safely removed', () => {
  it('removes a leading comma before the first member', () => {
    expect(repairJson('{,"a":1}')).toBe('{"a":1}');
  });

  it('removes a repeated comma between two members', () => {
    expect(repairJson('{"a":1,,"b":2}')).toBe('{"a":1,"b":2}');
  });

  it('removes three repeated commas between two members', () => {
    expect(repairJson('{"a":1,,,"b":2}')).toBe('{"a":1,"b":2}');
  });

  it('removes a leading comma even when it is the only content besides one member', () => {
    expect(repairJson('{,"a":1,}')).toBe('{"a":1}');
  });
});

describe('leading, repeated and elided commas in arrays require aggressive mode', () => {
  it('refuses a leading comma in an array in safe mode', () => {
    expect(() => repairJson('[,1,2]')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('inserts a null element for a leading comma in aggressive mode', () => {
    expect(repairJson('[,1,2]', { mode: 'aggressive' })).toBe('[null,1,2]');
  });

  it('refuses a repeated comma (elision) in an array in safe mode', () => {
    expect(() => repairJson('[1,,2]')).toThrowError(
      expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
    );
  });

  it('inserts a null element for elision in aggressive mode', () => {
    expect(repairJson('[1,,2]', { mode: 'aggressive' })).toBe('[1,null,2]');
  });
});

describe('missing commas between elements are always inserted', () => {
  it('inserts a missing comma between two object members', () => {
    expect(repairJson('{"a":1 "b":2}')).toBe('{"a":1,"b":2}');
  });

  it('inserts a missing comma between two array elements', () => {
    expect(repairJson('[1 2 3]')).toBe('[1,2,3]');
  });

  it('inserts a missing comma between two string array elements', () => {
    expect(repairJson('["a" "b"]')).toBe('["a","b"]');
  });

  it('inserts missing commas across a nested structure', () => {
    expect(repairJson('{"a":1 "b":[1 2]}')).toBe('{"a":1,"b":[1,2]}');
  });
});

describe('fixTrailingCommas:false disables trailing-comma removal', () => {
  it('fails to repair an object trailing comma when the flag is off', () => {
    expect(() => repairJson('{"a":1,}', { fixTrailingCommas: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('fails to repair an array trailing comma when the flag is off', () => {
    expect(() => repairJson('[1,2,]', { fixTrailingCommas: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });
});

describe('returnMetadata reports comma repairs with type and location', () => {
  it('records a single removed-trailing-comma repair with a position into the original input', () => {
    const input = '{"a":1,}';
    const result = repairJson(input, { returnMetadata: true });
    expect(result.changed).toBe(true);
    expect(result.repairs.map((r) => r.type)).toEqual(['removed-trailing-comma']);
    expect(result.repairs[0]?.position).toBe(input.indexOf(',', input.indexOf('1')));
    expect(result.repairs[0]?.line).toBe(1);
    expect(typeof result.repairs[0]?.column).toBe('number');
  });

  it('records a removed-extra-comma repair for a leading comma in an object', () => {
    const result = repairJson('{,"a":1}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['removed-extra-comma']);
  });

  it('records an added-missing-comma repair for a missing separator', () => {
    const result = repairJson('{"a":1 "b":2}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['added-missing-comma']);
  });

  it('records repairs in ascending position order for multiple comma issues', () => {
    const input = '{,"a":1,,"b":2,}';
    const result = repairJson(input, { returnMetadata: true });
    const positions = result.repairs.map((r) => r.position ?? -1);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
    expect(
      result.repairs.every(
        (r) => r.type === 'removed-extra-comma' || r.type === 'removed-trailing-comma',
      ),
    ).toBe(true);
  });
});
