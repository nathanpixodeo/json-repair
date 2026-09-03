import { resolveOptions } from './options.js';
import { repairInternal } from './repair.js';
import type { RepairOptions } from './types.js';

/**
 * Repairs malformed JSON and returns the parsed value.
 *
 * Equivalent to `JSON.parse(repairJson(input, options))`, but the value comes
 * from the validation stage that {@link repairJson} already runs, so the text is
 * never parsed twice.
 *
 * `T` is an unchecked assertion, exactly as with `JSON.parse`. Nothing here
 * validates the shape of the result against it — pair this with a schema
 * validator when the input is untrusted.
 *
 * @throws {JsonRepairError} `INVALID_INPUT`, `NO_JSON_FOUND`, `UNREPAIRABLE_JSON`,
 * `AMBIGUOUS_REPAIR`, `MAX_LENGTH_EXCEEDED`, `MAX_DEPTH_EXCEEDED` or
 * `MAX_REPAIRS_EXCEEDED`.
 */
export function parseJson<T = unknown>(input: string, options?: RepairOptions): T {
  return repairInternal(input, resolveOptions(options)).value as T;
}
