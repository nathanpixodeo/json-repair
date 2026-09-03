/**
 * References to the built-ins the engine depends on, captured when the module
 * is first evaluated.
 *
 * A repair library is often loaded into pages that also load third-party code,
 * and `JSON.parse` is a popular monkey-patching target. Holding the original
 * function means a later reassignment cannot change how this package validates
 * its own output, which is what the determinism guarantee rests on.
 */
export const parseJsonStrict: (text: string) => unknown = JSON.parse;
