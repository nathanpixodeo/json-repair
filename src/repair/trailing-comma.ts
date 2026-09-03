import type { RepairContext } from '../parser/state.js';
import { CH_CLOSE_BRACE, CH_CLOSE_BRACKET, CH_COMMA, CH_EOF } from '../scanner/tokens.js';
import { skipTrivia } from './comments.js';

/** What the parser found where a member or element separator was expected. */
export type Separator =
  /** A comma with more content after it. */
  | 'comma'
  /** A comma directly before the container's closer; it has been removed. */
  | 'trailing-comma'
  /** The container ends here — a closing bracket or end of input. */
  | 'end'
  /** Content continues but the comma is missing; one has been inserted. */
  | 'missing';

/**
 * Reads the separator after a member or element, recording whatever repair the
 * input needed.
 *
 * Trailing commas are the single most common JSON defect, and unlike most
 * repairs they are unambiguous in both directions: `[1,2,3,]` can only ever have
 * meant `[1,2,3]`. A missing comma is equally unambiguous once the parser has
 * confirmed that another member starts, which is why both are safe repairs.
 *
 * The cursor is left on the next meaningful character; the closer, if any, is
 * not consumed.
 */
export function readSeparator(ctx: RepairContext): Separator {
  skipTrivia(ctx);

  const code = ctx.scanner.peek();

  if (code === CH_COMMA) {
    const commaPosition = ctx.scanner.index;
    ctx.scanner.index += 1;
    skipTrivia(ctx);

    const next = ctx.scanner.peek();
    if (next === CH_CLOSE_BRACE || next === CH_CLOSE_BRACKET || next === CH_EOF) {
      if (!ctx.options.fixTrailingCommas) {
        ctx.fail('Trailing comma before the end of the container', commaPosition);
      }
      ctx.record('removed-trailing-comma', commaPosition);
      return 'trailing-comma';
    }
    return 'comma';
  }

  if (code === CH_CLOSE_BRACE || code === CH_CLOSE_BRACKET || code === CH_EOF) {
    return 'end';
  }

  ctx.record('added-missing-comma', ctx.scanner.index);
  return 'missing';
}
