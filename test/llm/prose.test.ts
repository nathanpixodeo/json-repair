import { describe, expect, it } from 'vitest';

import { extractAllJson, extractJson, isJsonRepairError, repairJson } from '../../src/index.js';

describe('prose surrounding a JSON payload', () => {
  const rows: [string, string][] = [
    ['prose before only', 'Here you go:\n{"a":1,}'],
    ['prose after only', '{"a":1,}\nHope that helps!'],
    ['prose before and after', 'Here you go:\n{"a":1,}\nHope that helps!'],
  ];

  for (const [label, input] of rows) {
    it(`extracts and repairs JSON with ${label}`, () => {
      expect(repairJson(input)).toBe('{"a":1}');
    });
  }
});

describe('chatty LLM preamble and closing remarks', () => {
  it('extracts JSON from a chatty preamble, fence and closing sentence', () => {
    const input = [
      "Sure! Here's the JSON you asked for:",
      '```json',
      '{"status":"ok","count":3}',
      '```',
      'Let me know if you need anything else!',
    ].join('\n');
    expect(repairJson(input)).toBe('{"status":"ok","count":3}');
  });

  it('extracts JSON when the preamble and closing remarks use **bold** markdown', () => {
    const input = [
      "**Sure! Here's the JSON you asked for:**",
      '```json',
      '{"status":"ok","count":3}',
      '```',
      '**Done.**',
    ].join('\n');
    expect(repairJson(input)).toBe('{"status":"ok","count":3}');
  });

  it('extracts JSON from a chatty preamble with no fence at all', () => {
    const input =
      'Sure! Here\'s the JSON you asked for: {"status": "ok", "count": 3,} Let me know if you need anything else!';
    expect(repairJson(input)).toBe('{"status":"ok","count":3}');
  });
});

describe('multiple JSON blocks in one document', () => {
  // Five sibling candidates, deliberately arranged so that "best", "first",
  // "last" and "largest" each resolve to a different block:
  //   s1 - first in the document, needs 1 repair, 8 chars
  //   s2 - needs 0 repairs but is short, so "best" no longer picks it, 9 chars
  //   s3 - joint longest and earliest of the two, so it wins "largest", 16 chars
  //   s4 - joint longest and needs no repair, so it wins "best", 16 chars
  //   s5 - last in the document, needs 1 repair, 10 chars
  //
  // s3 and s4 are the pair that keeps "best" and "largest" distinguishable:
  // both strategies rank by span first, and they part company only on the tie,
  // which "largest" gives to the earliest and "best" to the fewest repairs.
  const s1 = '{"a":1,}';
  const s2 = '{"bb":22}';
  const s3 = '[3,4,5,6,7,8,9,]';
  const s4 = '[3,4,5,6,7,8,90]';
  const s5 = '{"cc":33,}';
  const doc = `Here are five snippets: ${s1} then ${s2} plus ${s3} next ${s4} and finally ${s5} done.`;

  it('extractAllJson returns every candidate, verbatim, in document order', () => {
    expect(extractAllJson(doc)).toEqual([s1, s2, s3, s4, s5]);
  });

  it('extractJson with select "first" returns the first candidate, unrepaired', () => {
    expect(extractJson(doc, { select: 'first' })).toBe(s1);
  });

  it('extractJson with select "last" returns the last candidate, unrepaired', () => {
    expect(extractJson(doc, { select: 'last' })).toBe(s5);
  });

  it('extractJson with select "largest" breaks a span tie by document order', () => {
    expect(extractJson(doc, { select: 'largest' })).toBe(s3);
  });

  it('extractJson with select "best" (default) breaks a span tie by repair count', () => {
    expect(extractJson(doc)).toBe(s4);
    expect(extractJson(doc, { select: 'best' })).toBe(s4);
  });

  it('repairJson picks the best candidate among several blocks', () => {
    expect(repairJson(doc)).toBe('[3,4,5,6,7,8,90]');
  });
});

describe('decoys next to a real payload', () => {
  it('prefers the real JSON object over a bracketed citation-style decoy', () => {
    expect(repairJson('See [1] for details. {"a":1}')).toBe('{"a":1}');
  });

  it('extracts the real payload even when the decoy appears after it', () => {
    expect(repairJson('{"a":1} as noted in [1].')).toBe('{"a":1}');
  });

  it('prefers real JSON over a bracketed timestamp-like decoy', () => {
    expect(repairJson('[2024-01-01 12:00:00] {"level":"info"}')).toBe('{"level":"info"}');
  });
});

describe('a nested fragment never stands in for the document that contains it', () => {
  // Regression: candidate scanning offers every "{" and "[" in the region,
  // including ones inside another candidate. When the outer container failed
  // to parse and ranking preferred the candidate needing fewest repairs, an
  // already-valid inner array won and the rest of the object was silently
  // thrown away -- the worst failure mode this package has, because the caller
  // gets plausible JSON back and no indication that most of the input is gone.
  const rows: [string, string][] = [
    ['broken member before a valid array', '{"a": %BAD%, "b": [1, 2]}'],
    ['broken member after a valid array', '{"a": [1, 2], "b": %BAD%}'],
    ['broken member between two valid arrays', '{"a": [1], "b": %BAD%, "c": [2]}'],
  ];

  for (const [label, template] of rows) {
    it(`keeps the whole object when the ${label} needs aggressive mode`, () => {
      const input = template.replace('%BAD%', 'NaN');

      expect(() => repairJson(input)).toThrowError(
        expect.objectContaining({ code: 'AMBIGUOUS_REPAIR' }),
      );

      const repaired = repairJson(input, { mode: 'aggressive' });
      expect(JSON.parse(repaired)).toEqual(JSON.parse(template.replace('%BAD%', 'null')));
    });
  }

  it('never falls back to a nested value when the object around it is damaged', () => {
    // Each of these damages the object in a way that plain bracket counting
    // would mishandle -- a leading comma, a stray closer of the wrong kind, a
    // missing key -- and then puts a perfectly good array inside it. Whichever
    // way a mode resolves the damage, the answer is never the bare inner array.
    const inputs = [
      '{, "b": [1, 2]}',
      '{] "b": [1, 2]}',
      '{"a": ] , "b": [1, 2]}',
      '{: 1, "b": [1, 2]}',
    ];

    for (const input of inputs) {
      for (const mode of ['safe', 'aggressive'] as const) {
        let output: string;
        try {
          output = repairJson(input, { mode });
        } catch (error) {
          expect(isJsonRepairError(error)).toBe(true);
          continue;
        }
        expect(JSON.parse(output)).toEqual(expect.objectContaining({ b: [1, 2] }));
      }
    }
  });

  it('does not offer a nested value as a separate result from extractAllJson', () => {
    expect(extractAllJson('{"a": [1, 2], "b": {"c": 3}}')).toEqual([
      '{"a": [1, 2], "b": {"c": 3}}',
    ]);
  });
});

describe('a small valid decoy loses to the larger real payload', () => {
  // Ranking is longest-span-first precisely so that a citation marker, a
  // version array or any other incidental bracket in the prose cannot outrank
  // the document the caller actually asked for.
  const rows: [string, string, string][] = [
    ['a citation marker', 'see [1] for details {"real": true}', '{"real": true}'],
    ['a decoy after the payload', '{"real": true} -- see [1] for details', '{"real": true}'],
    [
      'an inline version array',
      'versions [1, 2] then {"name": "x", "ok": true}',
      '{"name": "x", "ok": true}',
    ],
  ];

  for (const [label, input, expected] of rows) {
    it(`extractJson skips ${label}`, () => {
      expect(extractJson(input)).toBe(expected);
    });
  }

  it('repairJson returns the payload even when the decoy needs no repair at all', () => {
    expect(repairJson('see [1] for details {real: true}')).toBe('{"real":true}');
  });

  it('select: "first" still honours document order, decoy included', () => {
    expect(extractJson('see [1] for details {"real": true}', { select: 'first' })).toBe('[1]');
  });

  it('extractAllJson reports both, in document order', () => {
    expect(extractAllJson('see [1] for details {"real": true}')).toEqual(['[1]', '{"real": true}']);
  });
});
