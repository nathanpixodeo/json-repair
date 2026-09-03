import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('case-variant spellings of true/false/null are normalized in safe mode', () => {
  const rows: [string, string][] = [
    ['{"a":True}', '{"a":true}'],
    ['{"a":TRUE}', '{"a":true}'],
    ['{"a":tRuE}', '{"a":true}'],
    ['{"a":False}', '{"a":false}'],
    ['{"a":FALSE}', '{"a":false}'],
    ['{"a":fAlSe}', '{"a":false}'],
    ['{"a":Null}', '{"a":null}'],
    ['{"a":NULL}', '{"a":null}'],
    ['{"a":nUlL}', '{"a":null}'],
  ];

  for (const [input, expected] of rows) {
    it(`normalizes ${JSON.stringify(input)} to ${JSON.stringify(expected)}`, () => {
      expect(repairJson(input)).toBe(expected);
    });
  }

  it('normalizes case variants at the top level and inside arrays too', () => {
    expect(repairJson('TRUE')).toBe('true');
    expect(repairJson('[True,False,Null]')).toBe('[true,false,null]');
  });

  it('leaves an already-canonical literal untouched even when other repairs are needed', () => {
    // "true" is already exactly canonical, so only the trailing comma is repaired.
    const result = repairJson('{"a":true,}', { returnMetadata: true });
    expect(result.json).toBe('{"a":true}');
    expect(result.repairs.map((r) => r.type)).toEqual(['removed-trailing-comma']);
  });
});

describe('lossy "no value" spellings require aggressive mode', () => {
  // For each of these, null is an approximation rather than a translation:
  // NaN and Infinity are numbers the author did write, and JSON.stringify
  // drops an undefined object member instead of nulling it. Two readings
  // exist, so safe mode declines to pick one.
  const rows: [string, string][] = [
    ['{"a":NaN}', '{"a":null}'],
    ['{"a":nan}', '{"a":null}'],
    ['{"a":Infinity}', '{"a":null}'],
    ['{"a":-Infinity}', '{"a":null}'],
    ['{"a":undefined}', '{"a":null}'],
  ];

  for (const [input, expected] of rows) {
    it(`refuses ${JSON.stringify(input)} in safe mode`, () => {
      expect(() => repairJson(input)).toThrowError(
        expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
      );
    });

    it(`rewrites ${JSON.stringify(input)} to ${JSON.stringify(expected)} in aggressive mode`, () => {
      expect(repairJson(input, { mode: 'aggressive' })).toBe(expected);
    });
  }

  it('rewrites every lossy "no value" spelling together in aggressive mode', () => {
    const input = '[NaN,Infinity,-Infinity,undefined]';
    expect(repairJson(input, { mode: 'aggressive' })).toBe('[null,null,null,null]');
  });
});

describe('Python None is safe, because null is a translation of it and not a guess', () => {
  // None is Python's spelling of null and loses nothing in the rewrite. The
  // only competing reading is the string "None", which needs unquoted string
  // values -- a rule safe mode does not apply at all. Accepting True while
  // refusing None would also split the single most common shape of LLM
  // output, a Python dict repr, down the middle.
  const rows: [string, string][] = [
    ['{"a":None}', '{"a":null}'],
    ['{"a":none}', '{"a":null}'],
    ['{"a":NONE}', '{"a":null}'],
    ["{'ok': True, 'note': None}", '{"ok":true,"note":null}'],
    ['[None,True,False]', '[null,true,false]'],
  ];

  for (const [input, expected] of rows) {
    it(`rewrites ${JSON.stringify(input)} to ${JSON.stringify(expected)} in safe mode`, () => {
      expect(repairJson(input)).toBe(expected);
    });

    it(`produces the same output for ${JSON.stringify(input)} in aggressive mode`, () => {
      expect(repairJson(input, { mode: 'aggressive' })).toBe(expected);
    });
  }
});

describe('returnMetadata reports literal repairs with type and location', () => {
  it('records normalized-literal for a case-variant true', () => {
    const result = repairJson('{"a":True}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['normalized-literal']);
    expect(result.repairs[0]?.position).toBe('{"a":'.length);
  });

  it('records normalized-literal for None rewritten as null in safe mode', () => {
    const result = repairJson('{"a":None}', { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['normalized-literal']);
    expect(result.repairs[0]?.position).toBe('{"a":'.length);
  });

  it('records normalized-literal for NaN rewritten as null in aggressive mode', () => {
    const result = repairJson('{"a":NaN}', { mode: 'aggressive', returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['normalized-literal']);
  });
});
