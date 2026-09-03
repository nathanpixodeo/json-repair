# @nexkit/json-repair

[![npm version](https://img.shields.io/npm/v/@nexkit/json-repair.svg)](https://www.npmjs.com/package/@nexkit/json-repair)
[![CI](https://github.com/nathanpixodeo/json-repair/actions/workflows/ci.yml/badge.svg)](https://github.com/nathanpixodeo/json-repair/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@nexkit/json-repair.svg)](https://github.com/nathanpixodeo/json-repair/blob/main/LICENSE)

Repair malformed JSON — from LLM output, logs, or hand-edited config — into valid JSON, deterministically and without running any code.

## Why this package

- **Zero runtime dependencies**, and the library core imports no `node:` built-ins, so it runs unchanged in browsers, Deno, Bun and edge runtimes as well as Node.
- **No regular expressions anywhere** in the engine, which rules out ReDoS as a category of problem, and **no code execution** — input is only ever scanned, never evaluated.
- **Deterministic and lossless where it can be.** The same input always repairs to the same bytes, valid JSON is returned untouched, and every repair is reported with its position so you can audit exactly what changed.
- **Two explicit modes.** `safe` only makes changes with a single plausible reading; `aggressive` adds heuristics for messier input, and never guesses silently — `safe` always runs first, so when it succeeds both modes agree byte for byte.

## Install

```sh
npm install @nexkit/json-repair
```

Node.js 18 or later. Ships as ESM and CommonJS, with bundled type declarations for both.

## Quick start

```ts
import { repairJson } from '@nexkit/json-repair';

repairJson('{name:"John",age:30,}');
// '{"name":"John","age":30}'
```

Valid JSON passes straight through, byte for byte:

```ts
repairJson('{"name":"John"}');
// '{"name":"John"}' — the exact same string, untouched
```

For LLM output wrapped in a code fence or surrounded by prose, extraction runs first automatically:

````ts
repairJson('Here is the result:\n```json\n{"ok":true}\n```\n');
// '{"ok":true}'
````

## What it repairs

`safe` mode (the default) applies every one of these:

| Input                     | Output              |
| ------------------------- | ------------------- |
| `{"name":"John",}`        | `{"name":"John"}`   |
| `[1,2,3,]`                | `[1,2,3]`           |
| `{'name':'John'}`         | `{"name":"John"}`   |
| `{name:"John"}`           | `{"name":"John"}`   |
| ` ```json\n{"a":1}\n``` ` | `{"a":1}`           |
| `Here:\n{"a":1}\nDone.`   | `{"a":1}`           |
| `{"users":[1,2,3`         | `{"users":[1,2,3]}` |

Beyond the table, `safe` mode also: strips `//`, `/* */` and `#` comments; normalizes single, backtick and typographic quotes to `"`; closes strings left open at end of input; drops a stray closing bracket that matches nothing; inserts a missing comma or colon between members; and removes a leading byte order mark. Every one of these behaviors has its own flag in [`RepairOptions`](#options) so you can turn any of them off individually.

`safe` mode also normalizes literals that spell a JSON value in another casing or another language: `True`, `FALSE`, `NULL` and Python's `None` all become `true`, `false` and `null`, so the dict repr that LLMs so often emit — `{'ok': True, 'note': None}` — repairs without needing `aggressive`.

## Safe vs aggressive

`mode: 'safe'` (the default) only ever applies a change when there is exactly one plausible reading of the input. When the input is genuinely ambiguous, it throws `AMBIGUOUS_REPAIR` rather than guess:

```ts
import { repairJson, isJsonRepairError } from '@nexkit/json-repair';

try {
  repairJson('{"a": NaN}');
} catch (error) {
  if (isJsonRepairError(error) && error.code === 'AMBIGUOUS_REPAIR') {
    repairJson('{"a": NaN}', { mode: 'aggressive' });
    // '{"a":null}'
  }
}
```

`mode: 'aggressive'` additionally:

- Quotes bare, unquoted string values: `{a: hello}` → `{"a":"hello"}`.
- Maps `NaN`, `Infinity` and `undefined` to `null`. (Python's `None` is handled in `safe` mode, alongside `True` and `False`, because `null` is a translation of it rather than an approximation.)
- Normalizes hex and leading-zero numbers to decimal: `0x1F` → `31`, `0123` → `123`.
- Fills elided array elements with `null`: `[1,,2]` → `[1,null,2]`.
- Treats an unescaped inner `"` as string content rather than a syntax error, escaping it in the output.
- Drops trailing content it cannot make sense of, rather than failing outright.

Aggressive mode always tries `safe` mode's rules first, so whenever `safe` mode succeeds on its own, both modes produce identical output.

## API reference

### `repairJson`

```ts
function repairJson(input: string, options?: RepairOptions & { returnMetadata?: false }): string;
function repairJson(input: string, options: RepairOptions & { returnMetadata: true }): RepairResult;
```

Repairs malformed JSON and returns the result as a string, or — with `returnMetadata: true` — as a `RepairResult` describing what changed.

```ts
repairJson('{a:1,}', { returnMetadata: true });
// {
//   json: '{"a":1}',
//   changed: true,
//   repairs: [
//     { type: 'quoted-key', position: 1, line: 1, column: 2, message: 'Quoted an unquoted key' },
//     { type: 'removed-trailing-comma', position: 4, line: 1, column: 5, message: 'Removed a trailing comma' }
//   ]
// }
```

Throws `JsonRepairError` — see [Errors](#errors) — for input that cannot be repaired, that exceeds a configured limit, or that is ambiguous under `safe` mode.

### `parseJson`

```ts
function parseJson<T = unknown>(input: string, options?: RepairOptions): T;
```

Equivalent to `JSON.parse(repairJson(input, options))`, but the text is never parsed twice — the value produced while validating the repair is reused directly.

```ts
parseJson<{ name: string }>('{name:"John"}').name;
// 'John'
```

`T` is an unchecked type assertion, exactly as with `JSON.parse` itself — nothing here validates the parsed value's shape against it. Pair this with a schema validator (Zod, Valibot, or similar) when the input is untrusted.

### `extractJson`

```ts
function extractJson(input: string, options?: ExtractOptions): string;
```

Locates the best embedded JSON value in a larger document and returns it **exactly as it appears in the input** — verbatim, not repaired. Use `repairJson` afterward if the extracted text may itself be malformed.

```ts
extractJson('Here:\n{a:1,}\nDone.');
// '{a:1,}'  — the raw, still-malformed slice
```

### `extractAllJson`

```ts
function extractAllJson(input: string, options?: ExtractOptions): string[];
```

Returns every JSON value found in a document, in document order, each verbatim. Returns `[]` when nothing is found, rather than throwing — unlike `extractJson`, "nothing here" is treated as an ordinary answer when the caller asked for everything.

```ts
extractAllJson('a: {"a":1} b: [1,2]');
// ['{"a":1}', '[1,2]']

extractAllJson('no json here at all');
// []
```

### `JsonRepairError` / `isJsonRepairError`

```ts
class JsonRepairError extends Error {
  readonly code: JsonRepairErrorCode;
  readonly position: number | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly snippet: string | undefined;
}
function isJsonRepairError(value: unknown): value is JsonRepairError;
```

The only error type this package throws. `code` is stable and meant for branching on; `message` text is not part of the contract and may change between releases. Prefer `isJsonRepairError` over `instanceof` — it recognizes instances created by a different copy of the package, which can happen when both the ESM and CommonJS builds are loaded into the same process.

```ts
try {
  repairJson('not json at all');
} catch (error) {
  if (isJsonRepairError(error)) {
    console.log(error.code, error.line, error.column, error.snippet);
    // 'NO_JSON_FOUND' 1 1 'not json at all'
  }
}
```

### Constants

`DEFAULT_MAX_DEPTH` (`512`), `DEFAULT_MAX_LENGTH` (`10_000_000`), `MAX_SUPPORTED_DEPTH` (`1024`, the hard ceiling `maxDepth` cannot exceed) and `REPAIR_TYPES` (every `RepairType`, in a stable order — useful for building exhaustive UIs or tests without hardcoding the list).

## Options

`RepairOptions`, accepted by `repairJson` and `parseJson`:

| Option               | Type                     | Default      | Effect                                                                                                           |
| -------------------- | ------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `mode`               | `'safe' \| 'aggressive'` | `'safe'`     | Repair strategy; see [Safe vs aggressive](#safe-vs-aggressive).                                                  |
| `extract`            | `boolean`                | `true`       | Isolate JSON from Markdown fences and surrounding prose before repairing.                                        |
| `allowComments`      | `boolean`                | `true`       | Accept and strip `//`, `/* */` and `#` comments.                                                                 |
| `allowSingleQuotes`  | `boolean`                | `true`       | Accept single-quoted strings.                                                                                    |
| `allowUnquotedKeys`  | `boolean`                | `true`       | Accept and quote bare object keys.                                                                               |
| `fixTrailingCommas`  | `boolean`                | `true`       | Remove a comma that directly precedes `}` or `]`.                                                                |
| `fixMissingBrackets` | `boolean`                | `true`       | Close a container that was never closed.                                                                         |
| `maxLength`          | `number`                 | `10_000_000` | Maximum accepted input length, in UTF-16 code units. Throws `MAX_LENGTH_EXCEEDED` past this.                     |
| `maxDepth`           | `number`                 | `512`        | Maximum accepted nesting depth, capped at `MAX_SUPPORTED_DEPTH` (`1024`). Throws `MAX_DEPTH_EXCEEDED` past this. |
| `maxRepairs`         | `number`                 | `Infinity`   | Maximum number of repair operations per attempt. Throws `MAX_REPAIRS_EXCEEDED` past this.                        |
| `returnMetadata`     | `boolean`                | `false`      | Return a `RepairResult` instead of a plain string.                                                               |

Every boolean flag is tri-state: leaving it `undefined` uses the default, while an explicit `true` or `false` always wins — passing `false` disables that repair rather than falling back to a default.

`ExtractOptions`, accepted by `extractJson` and `extractAllJson`, is the same set minus `extract` (which extraction obviously always performs) and `returnMetadata`, plus:

| Option   | Type                                       | Default  | Effect                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select` | `'best' \| 'first' \| 'last' \| 'largest'` | `'best'` | Which candidate wins when a document holds several JSON blocks. `best` picks the longest candidate, then the one needing fewest repairs, then the earliest — so a decoy like the `[1]` in "see [1] for details" loses to a real payload beside it, even when the decoy is already valid and the payload needs repairing. `first`/`last` pick by document order; `largest` picks by span, ties going to the earliest. |

## Errors

Every failure is a `JsonRepairError` with one of these codes:

| Code                   | Meaning                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`        | Input was not a string, or an option was out of range or the wrong type.                                                                     |
| `NO_JSON_FOUND`        | No repairable JSON value could be located in the input.                                                                                      |
| `UNREPAIRABLE_JSON`    | The input cannot be read as JSON at all, even with repairs applied.                                                                          |
| `MAX_LENGTH_EXCEEDED`  | Input exceeded `maxLength`.                                                                                                                  |
| `MAX_DEPTH_EXCEEDED`   | Nesting exceeded `maxDepth`.                                                                                                                 |
| `MAX_REPAIRS_EXCEEDED` | More repair operations were required than `maxRepairs` allows.                                                                               |
| `AMBIGUOUS_REPAIR`     | Several readings are possible and `safe` mode declines to choose; the error message names `mode: "aggressive"` as the way to force a choice. |

## CLI

```sh
npm install -g @nexkit/json-repair
```

```
Usage: json-repair [options] [file]

Repair malformed JSON from LLM output, logs, or hand-edited config, and
print valid JSON to standard output.

Reads from FILE when one is given, otherwise from standard input.

Options:
  -p, --pretty               Pretty-print the output with indentation
      --indent <n>           Spaces per indent level, used with --pretty
                             (0-10, default: 2)
  -e, --explain              Print a summary of applied repairs to stderr
  -m, --mode <mode>          Repair strategy: "safe" or "aggressive"
                             (default: "safe")
      --no-extract           Do not isolate JSON from surrounding text
      --no-comments          Reject //, /* */ and # comments
      --no-single-quotes     Reject single-quoted strings
      --no-unquoted-keys     Reject unquoted object keys
      --no-trailing-commas   Reject a comma right before } or ]
      --no-missing-brackets  Do not close an unterminated object or array
      --max-length <n>       Maximum accepted input length, in characters
      --max-depth <n>        Maximum accepted nesting depth
      --max-repairs <n>      Maximum number of repairs to apply
  -h, --help                 Show this help message and exit
  -v, --version              Print the version number and exit

Examples:
  json-repair data.json
  json-repair --pretty --explain broken.json > fixed.json
  cat broken.json | json-repair --mode aggressive
```

`--` ends flag parsing, so a filename that starts with `-` can still be passed. Short flags cluster (`-pe` means `-p -e`), and both `--flag value` and `--flag=value` work for options that take one.

Repair a file and print compact JSON to stdout:

```sh
$ echo '{name:"John",age:30,}' | json-repair
{"name":"John","age":30}
```

Pretty-print the result:

```sh
$ echo '{name:"John",age:30,}' | json-repair --pretty
{
  "name": "John",
  "age": 30
}
```

See exactly what was changed, on stderr, while stdout stays clean and pipeable:

```sh
$ echo '{name:"John",age:30,}' | json-repair --explain > /dev/null
Applied 3 repairs:
  1:2  quoted-key  Quoted an unquoted key
  1:14  quoted-key  Quoted an unquoted key
  1:20  removed-trailing-comma  Removed a trailing comma
```

Input that cannot be repaired exits `1` with a diagnostic on stderr, and stdout stays empty:

```sh
$ printf '%s' 'totally not json' | json-repair
json-repair: NO_JSON_FOUND: No JSON value was found in the input.
  at line 1, column 1: totally not json
$ echo $?
1
```

An unrecognized flag exits `2` as a usage error, without attempting to repair anything:

```sh
$ json-repair --bogus-flag
json-repair: unknown option '--bogus-flag'
Try 'json-repair --help' for more information.
$ echo $?
2
```

Exit codes: `0` on success, `1` when the input could not be repaired, `2` for a usage error in the command line itself.

## Performance

The engine targets **under 50 ms to repair a common defect in a 1 MB input, and linear time in input size** — no candidate is re-scanned from the start, so pathological input degrades gracefully rather than quadratically.

Measured on the built bundle (`dist/index.js`), Node 25.9 on Windows 11, Intel Core i7-12700. Every fixture is generated from a seeded pseudo-random generator rather than `Math.random()`, so the inputs are identical on every machine and every run. The 1 MB cases use 5 untimed warm-up iterations followed by 20 timed ones; the small and adversarial cases use 10 and 50. Each row reports the median and the 95th percentile of the timed iterations. Reproduce it all with `npm run build && npm run bench` — `bench/bench.mjs` is committed for exactly that reason.

| Case                                    | Input  | Median  | p95     |
| --------------------------------------- | ------ | ------- | ------- |
| Valid JSON (fast path)                  | 977 KB | 6.4 ms  | 12.3 ms |
| Trailing comma                          | 977 KB | 37.8 ms | 51.8 ms |
| Truncated mid-string                    | 586 KB | 23.4 ms | 28.1 ms |
| Prose plus a ` ```json ` fence          | 977 KB | 23.4 ms | 37.0 ms |
| Single-quoted strings throughout        | 977 KB | 43.5 ms | 69.6 ms |
| Small malformed object                  | 21 B   | 0.01 ms | 0.03 ms |
| 100,000 consecutive quotes (aggressive) | 98 KB  | 12.7 ms | 25.1 ms |
| 100,000 stray `}` (aggressive)          | 98 KB  | 0.6 ms  | 1.4 ms  |

Only the trailing-comma row carries the 50 ms budget, it is measured against the median, and `npm run bench` exits non-zero if it is ever missed. CI runs the same benchmark with `--no-budget`, which records the numbers without enforcing them, because a shared GitHub runner is roughly half the speed of the machine above — the trailing-comma case measures around 75 ms there — and enforcing a wall-clock budget on hardware that slow and that variable would report the runner rather than the code. Be aware that the two 1 MB rewriting cases cross 50 ms at the 95th percentile even though their medians sit well inside it: rebuilding an entire megabyte of output is enough work that a badly timed garbage collection shows up in the tail. The single-quote case is the slowest realistic input by some margin, because rewriting every delimiter means nothing can be copied through unchanged. The two adversarial rows are not realistic inputs at all — they exist to show that the engine stays linear under pathological conditions instead of blowing up, which is what matters when the input comes from untrusted text rather than a well-behaved model response.

## Security

- **Input limits by default.** `maxLength` (10,000,000 characters) and `maxDepth` (512, hard-capped at 1024) are enforced before and during scanning, so a caller does not have to remember to bound untrusted input themselves.
- **No code execution.** Input is only ever scanned and re-emitted as text; nothing is evaluated, and the parser never calls back into the input in any way that could execute it.
- **No regular expressions anywhere in the engine**, which removes ReDoS — catastrophic backtracking on adversarial input — as a possible failure mode entirely.
- **No prototype pollution.** A `"__proto__"` key in the input is treated as an ordinary JSON string key: it is emitted as plain JSON text, and `JSON.parse` — which every repaired output is validated against — assigns it as an own property rather than mutating `Object.prototype`.

## Limitations

- This package repairs syntax, not intent. It does not infer a schema, and in `safe` mode it never invents data that is not implied by a single, unambiguous reading of the input — it fails with `AMBIGUOUS_REPAIR` instead.
- `aggressive` mode's heuristics (quoting bare values, mapping non-JSON literals to `null`, and so on) are best-effort guesses about what the author meant. They are usually right for LLM output, but they are guesses, not proof.
- Extraction (`extract: true`, `extractJson`, `extractAllJson`) picks one JSON-shaped region out of a larger document using heuristics — longest, then fewest repairs, then earliest, by default. On genuinely ambiguous prose containing more than one plausible JSON block, it can pick the wrong one; use `select` or `extractAllJson` when you need to check every candidate yourself.
- Once at least one repair is applied, the output is canonical, compact JSON: key order is preserved, but the original indentation and whitespace style are not. (Input that was already valid JSON is the exception — it is always returned byte for byte, formatting included.)

## Compatibility

Node.js 18 and later. Ships as ESM (`import`) and CommonJS (`require`), with TypeScript type declarations for both. The library core (everything except the CLI) has no runtime dependencies and imports no `node:` built-ins, so it also runs in browsers, Deno, Bun and edge/serverless runtimes without modification.

## Contributing

Issues and pull requests are welcome at [github.com/nathanpixodeo/json-repair](https://github.com/nathanpixodeo/json-repair).

## License

MIT © nexkit
