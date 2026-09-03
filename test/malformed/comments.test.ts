import { describe, expect, it } from 'vitest';

import { repairJson } from '../../src/index.js';

describe('every comment syntax is stripped in safe mode', () => {
  it('strips a line comment starting with //', () => {
    expect(repairJson('{ // hi\n "a": 1 }')).toBe('{"a":1}');
  });

  it('strips a line comment starting with #', () => {
    expect(repairJson('{ # hi\n "a": 1 }')).toBe('{"a":1}');
  });

  it('strips a block comment', () => {
    expect(repairJson('{ /* hi */ "a": 1 }')).toBe('{"a":1}');
  });

  it('strips a block comment that spans multiple lines', () => {
    expect(repairJson('{\n/* this\nis\na comment */\n"a": 1\n}')).toBe('{"a":1}');
  });

  it('strips several comments in one document', () => {
    expect(repairJson('{ // hi\n "a": 1 /* x */, // trailing\n "b": 2 # end\n}')).toBe(
      '{"a":1,"b":2}',
    );
  });

  it('strips a line comment that is the very last thing in the document', () => {
    expect(repairJson('{"a":1} // trailing note')).toBe('{"a":1}');
  });

  it('strips a comment placed between an object key and its value', () => {
    expect(repairJson('{"a": /* comment */ 1}')).toBe('{"a":1}');
  });

  it('strips a comment placed inside an array', () => {
    expect(repairJson('[1, /* two */ 2, 3]')).toBe('[1,2,3]');
  });
});

describe('an unterminated block comment runs to the end of input', () => {
  it('treats everything after an unclosed /* as comment text', () => {
    expect(repairJson('{"a": 1 /* never closed')).toBe('{"a":1}');
  });

  it('drops an entire object whose only remaining content is an unterminated comment', () => {
    expect(repairJson('{"a": 1, "b": /* oops')).toBe('{"a":1}');
  });
});

describe('allowComments:false turns any comment into a hard failure', () => {
  it('fails on a // comment when the flag is off', () => {
    expect(() => repairJson('{ // hi\n "a": 1 }', { allowComments: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('fails on a # comment when the flag is off', () => {
    expect(() => repairJson('{ # hi\n "a": 1 }', { allowComments: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('fails on a /* */ comment when the flag is off', () => {
    expect(() => repairJson('{ /* hi */ "a": 1 }', { allowComments: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );
  });

  it('still repairs a document with no comments when the flag is off', () => {
    expect(repairJson('{"a":1,}', { allowComments: false })).toBe('{"a":1}');
  });
});

describe('non-standard whitespace between tokens is normalized', () => {
  it('accepts a non-breaking space as trivia and records the normalization', () => {
    const input = '{ "a":1}';
    const result = repairJson(input, { returnMetadata: true });
    expect(result.json).toBe('{"a":1}');
    expect(result.repairs.map((r) => r.type)).toEqual(['normalized-whitespace']);
  });

  it('accepts an ideographic space as trivia', () => {
    const input = '{"a":1,　"b":2}';
    expect(repairJson(input)).toBe('{"a":1,"b":2}');
  });
});

describe('returnMetadata reports comment repairs with type and location', () => {
  it('records one removed-comment entry per comment', () => {
    const input = '{ // one\n "a": 1, /* two */ "b": 2 }';
    const result = repairJson(input, { returnMetadata: true });
    expect(result.repairs.map((r) => r.type)).toEqual(['removed-comment', 'removed-comment']);
    expect(result.repairs[0]?.position).toBe(input.indexOf('//'));
    expect(result.repairs[1]?.position).toBe(input.indexOf('/*'));
  });
});
