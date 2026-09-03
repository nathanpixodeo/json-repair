import { Scanner } from '../scanner/scanner.js';
import type { JsonRepairErrorCode } from '../types.js';

/**
 * Brand used to identify errors from this package across module realms.
 *
 * A dual ESM/CJS package can be loaded twice in the same process (once through
 * `import`, once through `require`), which gives two distinct class objects and
 * makes `instanceof` unreliable. `Symbol.for` uses the cross-realm global
 * registry, so the brand stays identical for every copy.
 */
const ERROR_BRAND: unique symbol = Symbol.for('json-repair.error') as never;

/** Number of characters of context shown on either side of the failure point. */
const SNIPPET_RADIUS = 24;

/** Extra fields accepted when constructing a {@link JsonRepairError}. */
export interface JsonRepairErrorDetails {
  /** Zero-based offset into the original input, in UTF-16 code units. */
  position?: number;
  /** One-based line number in the original input. */
  line?: number;
  /** One-based column number in the original input. */
  column?: number;
  /** A short excerpt of the input around {@link JsonRepairErrorDetails.position}. */
  snippet?: string;
}

/**
 * The only error type thrown by this package.
 *
 * Every failure carries a stable {@link JsonRepairError.code} so callers can
 * branch on the reason without matching on message text, which is not part of
 * the public contract and may be reworded in any release.
 *
 * @example
 * ```ts
 * import { repairJson, isJsonRepairError } from '@nexkit/json-repair';
 *
 * try {
 *   repairJson(input);
 * } catch (error) {
 *   if (isJsonRepairError(error) && error.code === 'AMBIGUOUS_REPAIR') {
 *     return repairJson(input, { mode: 'aggressive' });
 *   }
 *   throw error;
 * }
 * ```
 */
export class JsonRepairError extends Error {
  /** Always `'JsonRepairError'`, so the name survives minification. */
  override readonly name = 'JsonRepairError';

  /** Stable, machine-readable failure reason. */
  readonly code: JsonRepairErrorCode;

  /** Zero-based offset into the original input, in UTF-16 code units. */
  readonly position: number | undefined;

  /** One-based line number in the original input. */
  readonly line: number | undefined;

  /** One-based column number in the original input. */
  readonly column: number | undefined;

  /** A short excerpt of the input around {@link JsonRepairError.position}. */
  readonly snippet: string | undefined;

  /** Cross-realm brand; see {@link isJsonRepairError}. */
  readonly [ERROR_BRAND] = true;

  constructor(code: JsonRepairErrorCode, message: string, details: JsonRepairErrorDetails = {}) {
    super(message);
    this.code = code;
    this.position = details.position;
    this.line = details.line;
    this.column = details.column;
    this.snippet = details.snippet;

    // Restores the prototype chain when the package is consumed as downlevelled
    // ES5, where `super()` would otherwise return a plain Error.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Reports whether a value is a {@link JsonRepairError}, including instances
   * created by a different copy of this package.
   *
   * Prefer this over `instanceof` — see {@link ERROR_BRAND}.
   */
  static isJsonRepairError(value: unknown): value is JsonRepairError {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<PropertyKey, unknown>)[ERROR_BRAND] === true
    );
  }
}

/**
 * Reports whether a value is a {@link JsonRepairError}, including instances
 * created by a different copy of this package (dual ESM/CJS loading).
 */
export function isJsonRepairError(value: unknown): value is JsonRepairError {
  return JsonRepairError.isJsonRepairError(value);
}

/**
 * Builds a fully located error from a raw source string.
 *
 * Callers that hold a {@link Scanner} already have a line index and should use
 * it. This helper exists for the stages that run outside the parser — limit
 * checks and the orchestration layer — so that every error the package throws
 * carries the same position, line, column and snippet fields.
 */
export function createError(
  code: JsonRepairErrorCode,
  message: string,
  source: string,
  position: number,
): JsonRepairError {
  const clamped = position < 0 ? 0 : position > source.length ? source.length : position;
  const { line, column } = new Scanner(source).positionAt(clamped);

  return new JsonRepairError(code, message, {
    position: clamped,
    line,
    column,
    snippet: buildSnippet(source, clamped),
  });
}

/**
 * Builds a single-line excerpt of `source` around `position`, with control
 * characters escaped and ellipses marking truncation.
 */
export function buildSnippet(source: string, position: number): string {
  const clamped = position < 0 ? 0 : position > source.length ? source.length : position;
  const start = clamped - SNIPPET_RADIUS < 0 ? 0 : clamped - SNIPPET_RADIUS;
  const end = clamped + SNIPPET_RADIUS > source.length ? source.length : clamped + SNIPPET_RADIUS;

  let excerpt = '';
  for (let index = start; index < end; index += 1) {
    excerpt += escapeForDisplay(source.charCodeAt(index));
  }

  return `${start > 0 ? '…' : ''}${excerpt}${end < source.length ? '…' : ''}`;
}

/** Renders one code unit safely for a single-line diagnostic message. */
function escapeForDisplay(code: number): string {
  switch (code) {
    case 0x08:
      return '\\b';
    case 0x09:
      return '\\t';
    case 0x0a:
      return '\\n';
    case 0x0c:
      return '\\f';
    case 0x0d:
      return '\\r';
    default:
      break;
  }
  if (code < 0x20 || code === 0x7f) {
    return `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return String.fromCharCode(code);
}
