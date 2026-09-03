#!/usr/bin/env node
// bench/bench.mjs
//
// A dependency-free performance benchmark for @nexkit/json-repair. It runs
// against the built package (`dist/index.js`), not the TypeScript source, so
// it must be run after `npm run build` — see the wrapper at the bottom of
// this file for what happens when that has not been done yet.
//
// Every fixture below is generated deterministically, from a seeded linear
// congruential generator (LCG) rather than `Math.random()`, so that the
// benchmark's input data — and therefore its reported numbers — are
// reproducible across machines and across runs. Nothing here reaches for
// `Math.random()` at all.
//
// This script is a Node.js-only, developer-run tool, not shipped library
// code, so (like scripts/check-portable.mjs) it is not subject to the
// zero-regex / no-Node-built-ins rules that eslint.config.js enforces for
// `src/**`.

import { cpus, platform, arch } from 'node:os';

// ---------------------------------------------------------------------------
// Deterministic pseudo-random number generation
// ---------------------------------------------------------------------------

/**
 * Creates a seeded linear congruential generator. Given the same seed, it
 * produces the same sequence of numbers in [0, 1) on every run, on every
 * machine — which is what makes the fixtures below reproducible.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function createLcg(seed) {
  let state = seed >>> 0;
  return function next() {
    // Constants from Numerical Recipes; more than sufficient for generating
    // benchmark fixture data (this is not a cryptographic RNG).
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const FIXTURE_SEED = 0xc0ffee;

// ---------------------------------------------------------------------------
// Fixture construction
// ---------------------------------------------------------------------------

const NAME_SYLLABLES = [
  'al',
  'an',
  'ar',
  'ba',
  'be',
  'bo',
  'ca',
  'co',
  'da',
  'de',
  'el',
  'en',
  'fa',
  'ga',
  'ha',
  'in',
  'ka',
  'la',
  'le',
  'ma',
  'mi',
  'na',
  'ne',
  'on',
  'pa',
  'ra',
  'ri',
  'sa',
  'se',
  'ta',
  'te',
  'va',
  'vi',
];

const TAG_POOL = [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'stable',
  'draft',
  'archived',
  'flagged',
  'reviewed',
  'pending',
];

function randomName(rng) {
  const syllableCount = 2 + Math.floor(rng() * 2);
  let name = '';
  for (let i = 0; i < syllableCount; i += 1) {
    name += NAME_SYLLABLES[Math.floor(rng() * NAME_SYLLABLES.length)];
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function randomTags(rng) {
  const count = 1 + Math.floor(rng() * 4);
  const tags = [];
  for (let i = 0; i < count; i += 1) {
    tags.push(TAG_POOL[Math.floor(rng() * TAG_POOL.length)]);
  }
  return tags;
}

function buildRecord(rng, id) {
  return {
    id,
    name: randomName(rng),
    active: rng() > 0.5,
    score: Math.round(rng() * 1_000_000) / 100,
    tags: randomTags(rng),
    address: {
      city: randomName(rng),
      zip: String(10_000 + Math.floor(rng() * 89_999)),
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/**
 * Builds a compact JSON array document of roughly `targetChars` characters
 * (UTF-16 code units, which equal bytes for this fixture's all-ASCII
 * content). Records are serialized one at a time and joined at the end, so
 * construction cost is linear in the final document size.
 *
 * @param {number} targetChars
 * @returns {string}
 */
function buildValidDocument(targetChars) {
  const rng = createLcg(FIXTURE_SEED);
  const parts = [];
  let size = 2; // account for the array's `[` and `]`
  let id = 0;
  while (size < targetChars) {
    const serialized = JSON.stringify(buildRecord(rng, id));
    parts.push(serialized);
    size += serialized.length + 1; // +1 for the separating comma
    id += 1;
  }
  return `[${parts.join(',')}]`;
}

/** Injects a trailing comma directly before the document's final `]`. */
function injectTrailingComma(json) {
  return `${json.slice(0, -1)},${json.slice(-1)}`;
}

/**
 * Truncates `json` at the first point at or after `approxIndex` that falls
 * at least three characters inside a string value, leaving the result with
 * an open, unterminated string — a common shape for LLM output cut off
 * mid-generation.
 *
 * @param {string} json
 * @param {number} approxIndex
 * @returns {string}
 */
function truncateMidString(json, approxIndex) {
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      } else if (i >= approxIndex && i - stringStart >= 3) {
        return json.slice(0, i);
      }
    } else if (ch === '"') {
      inString = true;
      stringStart = i + 1;
    }
  }
  throw new Error('truncateMidString: reached end of document without finding a cut point.');
}

/** Wraps a JSON document in surrounding prose plus a ```json fence. */
function wrapInMarkdown(json) {
  const fence = '```';
  return [
    'Here is the data you asked for, pulled from our records system:',
    '',
    `${fence}json`,
    json,
    fence,
    '',
    'Let me know if you would like it filtered or reformatted.',
  ].join('\n');
}

const ONE_MB_CHARS = 1_000_000;

const validDocument = buildValidDocument(ONE_MB_CHARS);
const trailingCommaDocument = injectTrailingComma(validDocument);
const truncatedDocument = truncateMidString(validDocument, Math.floor(validDocument.length * 0.6));
const markdownWrappedDocument = wrapInMarkdown(validDocument);
const smallMalformedObject = "{name:'John',age:30,}";
// 100,000 consecutive `"` characters embedded in what starts as a single
// string value. A repair engine that re-scans from the start on every
// candidate closing quote degrades quadratically on input like this; a
// linear-time scanner does not.
const adversarialQuotes = `{"text": "${'"'.repeat(100_000)}"}`;
// 100,000 closing braces after a complete value. Each one has to be classified
// as stray, which is O(1) only if the parser tracks its open containers with a
// counter rather than rescanning the document.
const adversarialClosers = `{"a":1}${'}'.repeat(100_000)}`;
// The same 1 MB document with every string delimiter turned into an apostrophe.
// The fixture is all-ASCII and contains no apostrophes of its own, so this
// substitution is exact and reversible.
const singleQuotedDocument = validDocument.split('"').join("'");

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/**
 * Runs `fn` for `warmup` untimed iterations, then for `iterations` timed
 * iterations, and returns the sorted list of per-iteration durations in
 * milliseconds. Errors thrown by `fn` are swallowed: several fixtures here
 * are expected to be rejected in `safe` mode (e.g. the adversarial input may
 * hit `AMBIGUOUS_REPAIR`), and we are timing the attempt, not requiring it
 * to succeed.
 *
 * @param {() => void} fn
 * @param {number} warmup
 * @param {number} iterations
 * @returns {number[]}
 */
function timeIterations(fn, warmup, iterations) {
  const run = () => {
    try {
      fn();
    } catch {
      // Expected for some fixtures; see the doc comment above.
    }
  };

  for (let i = 0; i < warmup; i += 1) {
    run();
  }

  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    run();
    const end = performance.now();
    samples.push(end - start);
  }
  samples.sort((a, b) => a - b);
  return samples;
}

/** @param {number[]} sortedSamples @param {number} fraction */
function percentile(sortedSamples, fraction) {
  const index = Math.min(sortedSamples.length - 1, Math.floor(fraction * sortedSamples.length));
  return sortedSamples[index];
}

// ---------------------------------------------------------------------------
// Benchmark cases
// ---------------------------------------------------------------------------

/**
 * `budgetMs` marks the SRS-mandated performance budget: repairing a ~1 MB
 * document with a single common defect (a trailing comma) must have a
 * median time at or under 50 ms. No other case carries a budget.
 */
function buildCases({ repairJson, extractJson }) {
  return [
    {
      id: 'valid-1mb',
      label: '~1 MB valid JSON (baseline, no repair needed)',
      input: validDocument,
      run: (input) => repairJson(input),
      warmup: 5,
      iterations: 20,
    },
    {
      id: 'trailing-comma-1mb',
      label: '~1 MB with a trailing comma (common repair)',
      input: trailingCommaDocument,
      run: (input) => repairJson(input),
      warmup: 5,
      iterations: 20,
      budgetMs: 50,
    },
    {
      id: 'truncated-1mb',
      label: '~1 MB truncated mid-string (unterminated)',
      input: truncatedDocument,
      run: (input) => repairJson(input),
      warmup: 5,
      iterations: 20,
    },
    {
      id: 'markdown-wrapped-1mb',
      label: '~1 MB wrapped in prose + a ```json fence',
      input: markdownWrappedDocument,
      run: (input) => extractJson(input),
      warmup: 5,
      iterations: 20,
    },
    {
      id: 'single-quotes-1mb',
      label: '~1 MB using single-quoted strings throughout',
      input: singleQuotedDocument,
      run: (input) => repairJson(input),
      warmup: 5,
      iterations: 20,
    },
    {
      id: 'small-malformed',
      label: "small malformed object {name:'John',age:30,}",
      input: smallMalformedObject,
      run: (input) => repairJson(input),
      warmup: 10,
      iterations: 50,
    },
    {
      id: 'adversarial-quotes',
      label: '100k consecutive quote characters (linearity check)',
      input: adversarialQuotes,
      // Aggressive mode is the interesting case: safe mode refuses this input
      // almost immediately, so timing it would measure the refusal rather than
      // the scan the linearity claim is about.
      run: (input) => repairJson(input, { mode: 'aggressive' }),
      warmup: 10,
      iterations: 50,
    },
    {
      id: 'adversarial-closers',
      label: '100k stray closing braces (linearity check)',
      input: adversarialClosers,
      run: (input) => repairJson(input, { mode: 'aggressive' }),
      warmup: 10,
      iterations: 50,
    },
  ];
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printMethodologyHeader() {
  const cpuModel = cpus()[0]?.model.trim() ?? 'unknown CPU';
  console.log('@nexkit/json-repair benchmark');
  console.log('='.repeat(30));
  console.log(`Date:      ${new Date().toISOString()}`);
  console.log(`Node.js:   ${process.version}`);
  console.log(`Platform:  ${platform()} / ${arch()}`);
  console.log(`CPU:       ${cpuModel} (${cpus().length} logical cores)`);
  console.log('');
  console.log(
    'Methodology: each case is run for a number of untimed warmup iterations ' +
      '(to let the JIT settle), then timed with performance.now() for a number ' +
      'of measured iterations. Reported figures are the median and 95th ' +
      'percentile (p95) of those measured iterations. The ~1 MB cases use 5 ' +
      'warmup + 20 timed iterations; the small-input cases use 10 warmup + 50 ' +
      'timed iterations, both noted per case below.',
  );
  console.log('');
}

function formatKb(chars) {
  return (chars / 1024).toFixed(1);
}

function formatMbPerSecond(chars, medianMs) {
  if (medianMs <= 0) {
    return 'n/a';
  }
  const megabytes = chars / (1024 * 1024);
  const seconds = medianMs / 1000;
  return (megabytes / seconds).toFixed(2);
}

/**
 * Whether a missed budget should report instead of failing the run.
 *
 * The budget is a wall-clock number, so enforcing it is only meaningful on
 * hardware whose speed is known. A shared cloud runner is roughly half the
 * speed of the machine the README documents and varies from run to run, so
 * enforcing there would measure the runner rather than the code, and would
 * turn red for reasons no commit caused. CI passes this flag; a developer
 * running `npm run bench` locally does not, and still gets a hard failure.
 */
const reportOnly = process.argv.includes('--no-budget');

async function main() {
  let jsonRepair;
  try {
    // A dynamic import, rather than a static one, is required here: it lets
    // us catch a missing `dist/` and print a friendly message instead of
    // letting Node's raw ERR_MODULE_NOT_FOUND stack trace through.
    jsonRepair = await import('../dist/index.js');
  } catch (error) {
    console.error('bench: could not load ../dist/index.js.');
    console.error('Run `npm run build` first, then re-run `npm run bench`.');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exitCode = 1;
    return;
  }

  printMethodologyHeader();

  const cases = buildCases(jsonRepair);
  const rows = [];
  let budgetFailure = null;

  for (const testCase of cases) {
    console.log(
      `Running "${testCase.label}" (${testCase.warmup} warmup + ${testCase.iterations} timed)...`,
    );
    const samples = timeIterations(
      () => testCase.run(testCase.input),
      testCase.warmup,
      testCase.iterations,
    );
    const median = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);

    rows.push({
      Case: testCase.label,
      'Input (KB)': formatKb(testCase.input.length),
      'Median (ms)': median.toFixed(3),
      'p95 (ms)': p95.toFixed(3),
      'Throughput (MB/s)': formatMbPerSecond(testCase.input.length, median),
    });

    if (typeof testCase.budgetMs === 'number' && median > testCase.budgetMs) {
      budgetFailure = { testCase, median };
    }
  }

  console.log('');
  console.table(rows);
  console.log('');

  if (budgetFailure) {
    const message =
      `case "${budgetFailure.testCase.label}" had a median of ` +
      `${budgetFailure.median.toFixed(3)} ms, over the ${budgetFailure.testCase.budgetMs} ms ` +
      'budget for repairing a ~1 MB document with a common defect (SRS performance budget).';

    if (reportOnly) {
      console.log(`PERFORMANCE BUDGET NOT MET (report-only): ${message}`);
      return;
    }

    console.error(`PERFORMANCE BUDGET EXCEEDED: ${message}`);
    process.exitCode = 1;
    return;
  }

  console.log('All cases are within their performance budgets.');
}

main();
