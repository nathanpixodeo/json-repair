#!/usr/bin/env node
// scripts/check-portable.mjs
//
// Verifies that the compiled library bundle is genuinely platform-neutral:
// safe to load in a browser, in Deno, or on an edge runtime, with no
// dependency on Node.js built-in modules or Node-only globals. This is a
// build-time gate (wired up as `npm run check:portable`, and as the final
// step of `npm run verify`), not shipped code, so it is allowed to use
// Node.js built-ins and regular expressions itself — the zero-regex,
// no-Node-built-ins rules enforced by eslint.config.js apply only to the
// library source under `src/**`, never to this script.
//
// IMPORTANT: every check below must run against the *contents of the dist
// files we read from disk*, never against this script's own source text.
// This file's source necessarily contains strings such as "node:fs",
// "__dirname", and "require(" (because it is looking for them), so it is
// essential that scanning only ever happens on the strings returned by
// readFileSync() for the dist artifacts, and never on `import.meta.url` or
// this module itself.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const distDir = join(process.cwd(), 'dist');

// The two JavaScript bundles are scanned for forbidden content; the two
// declaration files are only required to exist (a `.d.ts`/`.d.cts` file
// cannot itself pull in a Node built-in at runtime, so there is nothing
// further to scan in them).
const bundleFiles = ['index.js', 'index.cjs'];
const declarationFiles = ['index.d.ts', 'index.d.cts'];

// Node.js built-in modules that the library core must never reference,
// whether via a bare specifier (`require('fs')`, `from 'path'`) or via the
// `node:` prefixed form (checked separately below, since that check is not
// limited to this specific list).
const NODE_BUILTINS = [
  'fs',
  'path',
  'os',
  'process',
  'child_process',
  'crypto',
  'util',
  'stream',
  'buffer',
  'worker_threads',
];

/**
 * Looks for any quoted specifier beginning with the "node:" scheme, e.g.
 * `'node:fs'` or `"node:path"`. This check is intentionally not limited to
 * NODE_BUILTINS: any `node:`-prefixed specifier proves the bundle depends
 * on Node's module resolver, regardless of which built-in it names.
 *
 * @param {string} source
 * @returns {string | null} the matched specifier text, or null if none found.
 */
function findNodeSchemeSpecifier(source) {
  const match = /['"`]node:[a-zA-Z_]+/.exec(source);
  return match ? match[0] : null;
}

/**
 * Looks for a bare (non-"node:"-prefixed) reference to one of the listed
 * Node.js built-ins, in any of the three forms a bundler is likely to
 * produce: a CommonJS `require(...)` call, an ES module `from '...'`
 * specifier, or a dynamic `import(...)` call.
 *
 * @param {string} source
 * @returns {{ name: string, snippet: string } | null}
 */
function findBareBuiltinReference(source) {
  for (const name of NODE_BUILTINS) {
    const patterns = [
      new RegExp(`require\\(\\s*['"]${name}['"]\\s*\\)`),
      new RegExp(`from\\s*['"]${name}['"]`),
      new RegExp(`import\\(\\s*['"]${name}['"]\\s*\\)`),
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(source);
      if (match) {
        return { name, snippet: match[0] };
      }
    }
  }
  return null;
}

/**
 * Checks for a standalone occurrence of the given identifier (matched on
 * word boundaries, so e.g. "preprocess" does not falsely match "process").
 *
 * @param {string} source
 * @param {string} identifier
 * @returns {boolean}
 */
function containsIdentifier(source, identifier) {
  return new RegExp(`\\b${identifier}\\b`).test(source);
}

/**
 * Runs every portability check against a single dist file's contents and
 * returns a list of human-readable violation descriptions (empty if clean).
 *
 * @param {string} relativePath
 * @param {string} source
 * @returns {string[]}
 */
function scanBundle(relativePath, source) {
  const violations = [];

  const nodeScheme = findNodeSchemeSpecifier(source);
  if (nodeScheme) {
    violations.push(`${relativePath}: found a "node:" specifier (${nodeScheme}).`);
  }

  const bareBuiltin = findBareBuiltinReference(source);
  if (bareBuiltin) {
    violations.push(
      `${relativePath}: found a reference to the Node built-in "${bareBuiltin.name}" (${bareBuiltin.snippet}).`,
    );
  }

  if (containsIdentifier(source, '__dirname')) {
    violations.push(`${relativePath}: found the CommonJS-only identifier "__dirname".`);
  }
  if (containsIdentifier(source, '__filename')) {
    violations.push(`${relativePath}: found the CommonJS-only identifier "__filename".`);
  }

  // `process` gets its own explicit check, on top of the bare-builtin scan
  // above: the library core has no legitimate reason to reference the
  // `process` global anywhere (see the no-restricted-globals rule in
  // eslint.config.js), so any occurrence at all — not just
  // `require('process')` — is treated as a portability failure.
  if (containsIdentifier(source, 'process')) {
    violations.push(`${relativePath}: found a reference to the Node-only global "process".`);
  }

  return violations;
}

function main() {
  const missing = [...bundleFiles, ...declarationFiles].filter(
    (fileName) => !existsSync(join(distDir, fileName)),
  );
  if (missing.length > 0) {
    console.error('check-portable: missing expected build output:');
    for (const fileName of missing) {
      console.error(`  - dist/${fileName}`);
    }
    console.error('Run `npm run build` first, then re-run `npm run check:portable`.');
    process.exitCode = 1;
    return;
  }

  const allViolations = bundleFiles.flatMap((fileName) => {
    const source = readFileSync(join(distDir, fileName), 'utf8');
    return scanBundle(`dist/${fileName}`, source);
  });

  if (allViolations.length > 0) {
    console.error(
      'check-portable: the build output is not platform-neutral. The library core must run unmodified in browsers, Deno, and edge runtimes, so it may not reference Node.js built-ins or Node-only globals:',
    );
    for (const violation of allViolations) {
      console.error(`  - ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  const checkedFiles = [...bundleFiles, ...declarationFiles].map((fileName) => `dist/${fileName}`);
  console.log(`OK: portable build check passed for ${checkedFiles.join(', ')}.`);
}

main();
