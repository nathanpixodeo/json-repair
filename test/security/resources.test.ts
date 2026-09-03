import { describe, expect, it } from 'vitest';

import { isJsonRepairError, repairJson } from '../../src/index.js';

/**
 * Runs a potentially hostile repair call and asserts the library's baseline
 * safety contract for adversarial input: the call either returns text that
 * `JSON.parse` accepts, or it throws a `JsonRepairError`. It must never throw
 * a `RangeError`, a `TypeError`, or any other non-library exception, and it
 * must never hang. `boundMs` is intentionally generous (seconds, not
 * milliseconds) so the assertion is meaningful without flaking on slower CI
 * hardware or under v8 coverage instrumentation, which costs roughly an order
 * of magnitude. What these bounds catch is a quadratic or exponential blowup,
 * which turns a sub-second repair into minutes — not a few milliseconds of
 * drift.
 */
function assertResourceSafe(fn: () => unknown, boundMs: number): void {
  const started = Date.now();
  let threw = false;
  let result: unknown;
  try {
    result = fn();
  } catch (error) {
    threw = true;
    expect(isJsonRepairError(error)).toBe(true);
  }
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(boundMs);
  if (!threw) {
    expect(typeof result).toBe('string');
    expect(() => JSON.parse(result as string)).not.toThrow();
  }
}

describe('resource abuse resilience', () => {
  it('handles 200,000 consecutive double quotes inside a string value, safe mode', () => {
    const input = `{"a":"${'"'.repeat(200_000)}"}`;
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles 200,000 consecutive double quotes inside a string value, aggressive mode', () => {
    const input = `{"a":"${'"'.repeat(200_000)}"}`;
    assertResourceSafe(() => repairJson(input, { mode: 'aggressive' }), 20000);
  });

  it('handles 200,000 consecutive backslash characters inside a string value, safe mode', () => {
    const input = `{"a":"${'\\'.repeat(200_000)}"}`;
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles 200,000 consecutive backslash characters inside a string value, aggressive mode', () => {
    const input = `{"a":"${'\\'.repeat(200_000)}"}`;
    assertResourceSafe(() => repairJson(input, { mode: 'aggressive' }), 20000);
  });

  it('handles 100,000 consecutive open braces with no closers, safe mode', () => {
    // A bare "{" can never start an object key (even in aggressive mode; see
    // canStartKey / isStructural in the parser), so this shape never recurses
    // and never reaches a meaningful nesting depth. It is included here as a
    // resource-abuse case in its own right: the assertion is the general
    // safety contract (valid JSON or JsonRepairError, fast, no stack
    // overflow), not a specific error code. Genuine deep-recursion guarding
    // is covered separately via nested arrays in limits.test.ts.
    const input = '{'.repeat(100_000);
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles 100,000 consecutive open braces with no closers, aggressive mode', () => {
    const input = '{'.repeat(100_000);
    assertResourceSafe(() => repairJson(input, { mode: 'aggressive' }), 20000);
  });

  it('handles 100,000 consecutive close braces after a small valid value, safe mode', () => {
    const input = '{"a":1}' + '}'.repeat(100_000);
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles 100,000 consecutive close braces after a small valid value, aggressive mode', () => {
    const input = '{"a":1}' + '}'.repeat(100_000);
    assertResourceSafe(() => repairJson(input, { mode: 'aggressive' }), 20000);
  });

  it('handles a roughly 1 MB document of alternating {"a": fragments', () => {
    // This never closes a single value, so nesting depth grows without bound
    // until the configured maxDepth cuts the parse short. It must fail fast,
    // well before the parser has scanned the whole megabyte.
    const input = '{"a":'.repeat(Math.ceil(1_000_000 / 6));
    const started = Date.now();
    expect(() => repairJson(input)).toThrowError(
      expect.objectContaining({ code: 'MAX_DEPTH_EXCEEDED' }),
    );
    expect(Date.now() - started).toBeLessThan(20000);
  });

  it('handles deeply nested valid input at exactly the default maxDepth without a stack overflow', () => {
    const input = `${'['.repeat(512)}1${']'.repeat(512)}`;
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles deeply nested valid input one level past the default maxDepth without a stack overflow', () => {
    const input = `${'['.repeat(513)}1${']'.repeat(513)}`;
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles 50,000 unclosed Markdown fences ahead of a valid payload', () => {
    const input = '```\n'.repeat(50_000) + '{"a":1}';
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles a long run of an unterminated block comment', () => {
    // A periodic repetition of the two-character substring "/*" is not a
    // useful stress case: it contains "*/" as a substring almost immediately
    // and self-terminates after a handful of characters. To genuinely
    // exercise the "runs to end of input" fallback in the block-comment
    // scanner, the body must never contain the closing sequence "*/".
    const input = '/*' + '*'.repeat(200_000);
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles 100,000 \\u escape prefixes with no hex digits, safe mode', () => {
    const input = `{"a":"${'\\u'.repeat(100_000)}"}`;
    assertResourceSafe(() => repairJson(input), 20000);
  });

  it('handles 100,000 \\u escape prefixes with no hex digits, aggressive mode', () => {
    const input = `{"a":"${'\\u'.repeat(100_000)}"}`;
    assertResourceSafe(() => repairJson(input, { mode: 'aggressive' }), 20000);
  });
});
