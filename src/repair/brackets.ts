import type { RepairContext } from '../parser/state.js';
import { CH_CLOSE_BRACE } from '../scanner/tokens.js';

/** Which container the parser is inside. */
export type ContainerKind = 'object' | 'array';

/**
 * Records the implicit closing of a container that the input never closed.
 *
 * Truncated output — a cut-off stream, a response that hit a token limit — is
 * the usual cause, and there is only one way to close the containers that are
 * still open, so this is a safe repair. Callers that set
 * `fixMissingBrackets: false` get a hard failure instead.
 */
export function closeUnterminated(ctx: RepairContext, kind: ContainerKind, position: number): void {
  if (!ctx.options.fixMissingBrackets) {
    ctx.fail(kind === 'object' ? 'Object is never closed' : 'Array is never closed', position);
  }
  ctx.record(kind === 'object' ? 'added-closing-brace' : 'added-closing-bracket', position);
}

/**
 * Consumes a closing bracket that matches no open container.
 *
 * At the very end of the input a stray closer is almost always a typo for the
 * right one — `{"a":1]` can only have meant `{"a":1}` — so it is dropped
 * safely and the correct closer is added by {@link closeUnterminated}.
 * Anywhere else the bracket may be marking a real structural boundary, so only
 * aggressive mode discards it.
 */
export function dropStrayCloser(ctx: RepairContext): void {
  const position = ctx.scanner.index;
  const atEnd = position === ctx.lastContentIndex;

  if (!atEnd && !ctx.options.aggressive) {
    const character = ctx.scanner.peek() === CH_CLOSE_BRACE ? '}' : ']';
    ctx.refuse(`Unexpected "${character}" with no matching opening bracket`, position);
  }

  ctx.record('removed-stray-token', position);
  ctx.scanner.index = position + 1;
}
