import { describe, expect, it } from 'vitest';

import { extractJson, repairJson } from '../../src/index.js';

/**
 * Coverage for option validation: every field of `RepairOptions` is checked
 * against the wrong JavaScript type, numeric limits are checked for
 * non-integer and out-of-range values, `mode` and `select` are checked
 * against unknown strings, and the options bag itself is checked against
 * non-object values. A final section verifies the tri-state contract of the
 * six boolean repair flags: leaving one `undefined` uses the mode default,
 * an explicit `false` always disables the corresponding repair (even in
 * aggressive mode, which would otherwise apply it), and an explicit `true`
 * always behaves exactly like the default.
 */

function expectInvalidInput(fn: () => unknown, nameInMessage: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as { code?: string }).code).toBe('INVALID_INPUT');
  expect((caught as Error).message).toContain(nameInMessage);
}

describe('options bag itself must be an object', () => {
  const badBags: [string, unknown][] = [
    ['a number', 42],
    ['a string', 'x'],
    ['null', null],
  ];

  for (const [label, bag] of badBags) {
    it(`rejects ${label}`, () => {
      expectInvalidInput(() => repairJson('{"a":1}', bag as never), 'Options must be an object');
    });
  }

  it('accepts undefined options (uses defaults)', () => {
    expect(repairJson('{"a":1}', undefined)).toBe('{"a":1}');
  });
});

describe('every option field rejects the wrong JavaScript type', () => {
  const cases: [string, unknown, string][] = [
    ['mode', 42, 'mode'],
    ['extract', 'yes', 'extract'],
    ['allowComments', 1, 'allowComments'],
    ['allowSingleQuotes', 1, 'allowSingleQuotes'],
    ['allowUnquotedKeys', 1, 'allowUnquotedKeys'],
    ['fixTrailingCommas', 1, 'fixTrailingCommas'],
    ['fixMissingBrackets', 1, 'fixMissingBrackets'],
    ['maxLength', '10', 'maxLength'],
    ['maxDepth', '10', 'maxDepth'],
    ['maxRepairs', '10', 'maxRepairs'],
    ['returnMetadata', 1, 'returnMetadata'],
  ];

  for (const [field, badValue, expectedName] of cases) {
    it(`rejects a non-boolean/non-number "${field}"`, () => {
      expectInvalidInput(
        () => repairJson('{"a":1}', { [field]: badValue } as never),
        `"${expectedName}"`,
      );
    });
  }
});

describe('numeric limits reject non-integer and out-of-range values', () => {
  const limitFields = ['maxLength', 'maxDepth', 'maxRepairs'] as const;

  for (const field of limitFields) {
    it(`rejects a non-integer "${field}"`, () => {
      expectInvalidInput(() => repairJson('{"a":1}', { [field]: 1.5 } as never), `"${field}"`);
    });

    it(`rejects a negative "${field}"`, () => {
      expectInvalidInput(() => repairJson('{"a":1}', { [field]: -1 } as never), `"${field}"`);
    });

    it(`rejects NaN for "${field}"`, () => {
      expectInvalidInput(() => repairJson('{"a":1}', { [field]: NaN } as never), `"${field}"`);
    });
  }

  it('allows maxRepairs: 0 when no repair is actually needed', () => {
    expect(repairJson('{"a":1}', { maxRepairs: 0 })).toBe('{"a":1}');
  });

  it('rejects maxLength: 0 (below its minimum of 1)', () => {
    expectInvalidInput(() => repairJson('{"a":1}', { maxLength: 0 }), '"maxLength"');
  });

  it('rejects maxDepth: 0 (below its minimum of 1)', () => {
    expectInvalidInput(() => repairJson('[1]', { maxDepth: 0 }), '"maxDepth"');
  });

  it('accepts maxDepth at MAX_SUPPORTED_DEPTH (1024)', () => {
    expect(repairJson('[1]', { maxDepth: 1024 })).toBe('[1]');
  });

  it('rejects maxDepth one above MAX_SUPPORTED_DEPTH (1025)', () => {
    expectInvalidInput(() => repairJson('[1]', { maxDepth: 1025 }), '"maxDepth"');
  });

  it('allows maxLength / maxRepairs of Infinity, which is not an integer but is explicitly permitted', () => {
    expect(repairJson('{"a":1}', { maxLength: Infinity, maxRepairs: Infinity })).toBe('{"a":1}');
  });
});

describe('mode is validated against a fixed set of strings', () => {
  it('rejects an unknown mode string', () => {
    expectInvalidInput(() => repairJson('{"a":1}', { mode: 'BOGUS' as never }), '"mode"');
  });

  it('accepts "safe" and "aggressive"', () => {
    expect(repairJson('{"a":1}', { mode: 'safe' })).toBe('{"a":1}');
    expect(repairJson('{"a":1}', { mode: 'aggressive' })).toBe('{"a":1}');
  });
});

describe('select is validated against a fixed set of strings', () => {
  it('rejects an unknown select strategy', () => {
    expectInvalidInput(() => extractJson('{"a":1}', { select: 'BOGUS' as never }), '"select"');
  });

  it('accepts every documented select strategy', () => {
    for (const select of ['best', 'first', 'last', 'largest'] as const) {
      expect(extractJson('{"a":1}', { select })).toBe('{"a":1}');
    }
  });
});

describe('tri-state boolean flags', () => {
  // Each flag is exercised with a fixture that, in aggressive mode by
  // default, would normally be repaired. Passing `false` must disable that
  // repair even though aggressive mode is active, and passing `true` must
  // reproduce exactly what the default (leaving the flag `undefined`)
  // produces for the same input and mode.

  it('allowComments: false rejects comments even in aggressive mode; true matches the default', () => {
    const input = '{ "a": 1 /* c */ }';
    const disabled = repairJson(input, { mode: 'aggressive', allowComments: false });
    // Disabling comment recognition does not throw in aggressive mode: the
    // comment body is instead swallowed as bare, mangled content.
    expect(disabled).not.toBe('{"a":1}');
    expect(() => JSON.parse(disabled)).not.toThrow();

    const explicitTrue = repairJson(input, { mode: 'aggressive', allowComments: true });
    const defaulted = repairJson(input, { mode: 'aggressive' });
    expect(explicitTrue).toBe(defaulted);
    expect(explicitTrue).toBe('{"a":1}');
  });

  it('allowSingleQuotes: false throws even in aggressive mode; true matches the default', () => {
    const input = "{'a':1}";
    expect(() => repairJson(input, { mode: 'aggressive', allowSingleQuotes: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );

    const explicitTrue = repairJson(input, { mode: 'aggressive', allowSingleQuotes: true });
    const defaulted = repairJson(input, { mode: 'aggressive' });
    expect(explicitTrue).toBe(defaulted);
    expect(explicitTrue).toBe('{"a":1}');
  });

  it('allowUnquotedKeys: false drops the unrecognised key even in aggressive mode; true matches the default', () => {
    const input = '{a:1}';
    const disabled = repairJson(input, { mode: 'aggressive', allowUnquotedKeys: false });
    expect(disabled).toBe('{}');

    const explicitTrue = repairJson(input, { mode: 'aggressive', allowUnquotedKeys: true });
    const defaulted = repairJson(input, { mode: 'aggressive' });
    expect(explicitTrue).toBe(defaulted);
    expect(explicitTrue).toBe('{"a":1}');
  });

  it('fixTrailingCommas: false throws even in aggressive mode; true matches the default', () => {
    const input = '{"a":1,}';
    expect(() => repairJson(input, { mode: 'aggressive', fixTrailingCommas: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );

    const explicitTrue = repairJson(input, { mode: 'aggressive', fixTrailingCommas: true });
    const defaulted = repairJson(input, { mode: 'aggressive' });
    expect(explicitTrue).toBe(defaulted);
    expect(explicitTrue).toBe('{"a":1}');
  });

  it('fixMissingBrackets: false throws even in aggressive mode; true matches the default', () => {
    const input = '{"a":1';
    expect(() => repairJson(input, { mode: 'aggressive', fixMissingBrackets: false })).toThrowError(
      expect.objectContaining({ code: 'UNREPAIRABLE_JSON' }),
    );

    const explicitTrue = repairJson(input, { mode: 'aggressive', fixMissingBrackets: true });
    const defaulted = repairJson(input, { mode: 'aggressive' });
    expect(explicitTrue).toBe(defaulted);
    expect(explicitTrue).toBe('{"a":1}');
  });

  it('extract: false disables isolation even in aggressive mode; true matches the default', () => {
    const input = 'Here: {"a":1} done.';
    const disabled = repairJson(input, { mode: 'aggressive', extract: false });
    // With extraction disabled, the whole region is fed to the parser as one
    // value; it is not the embedded object.
    expect(disabled).not.toBe('{"a":1}');

    const explicitTrue = repairJson(input, { mode: 'aggressive', extract: true });
    const defaulted = repairJson(input, { mode: 'aggressive' });
    expect(explicitTrue).toBe(defaulted);
    expect(explicitTrue).toBe('{"a":1}');
  });

  it('every flag left undefined behaves exactly like every flag explicitly set to true', () => {
    const input = "{a:1,'b':2,}";
    const allDefault = repairJson(input, { mode: 'aggressive' });
    const allExplicitTrue = repairJson(input, {
      mode: 'aggressive',
      extract: true,
      allowComments: true,
      allowSingleQuotes: true,
      allowUnquotedKeys: true,
      fixTrailingCommas: true,
      fixMissingBrackets: true,
    });
    expect(allExplicitTrue).toBe(allDefault);
  });
});
