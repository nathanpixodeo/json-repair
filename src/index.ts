/**
 * `@nexkit/json-repair` — turn malformed JSON into valid JSON, safely.
 *
 * Everything exported here is part of the public API and is covered by semantic
 * versioning. Nothing else in `src/` is: deep imports into subpaths are not
 * supported and may change in any release.
 *
 * The library core has zero runtime dependencies, imports no Node built-ins and
 * evaluates no input, so it runs unchanged in browsers, Deno, Bun and edge
 * runtimes as well as Node.
 */

export { repairJson } from './repair.js';
export { parseJson } from './parse.js';
export { extractJson, extractAllJson } from './extract.js';

export { JsonRepairError, isJsonRepairError } from './errors/JsonRepairError.js';
export { DEFAULT_MAX_DEPTH, DEFAULT_MAX_LENGTH } from './options.js';

export { MAX_SUPPORTED_DEPTH, REPAIR_TYPES } from './types.js';
export type {
  ExtractOptions,
  JsonRepairErrorCode,
  RepairMode,
  RepairOperation,
  RepairOptions,
  RepairResult,
  RepairType,
} from './types.js';
