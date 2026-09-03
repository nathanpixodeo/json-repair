import type { RepairType } from '../types.js';

/**
 * Human-readable description for each {@link RepairType}.
 *
 * Used as the default {@link RepairOperation.message} and rendered by the CLI's
 * `--explain` output. These strings are documentation, not contract: match on
 * {@link RepairType} instead.
 */
const MESSAGES: Record<RepairType, string> = {
  'removed-byte-order-mark': 'Removed a leading byte order mark',
  'extracted-json': 'Extracted JSON from surrounding text',
  'removed-comment': 'Removed a comment',
  'normalized-whitespace': 'Replaced whitespace that JSON does not allow between tokens',
  'removed-trailing-comma': 'Removed a trailing comma',
  'removed-extra-comma': 'Removed a redundant comma',
  'removed-stray-token': 'Removed a closing bracket that matched nothing',
  'removed-trailing-content': 'Removed content after the end of the JSON value',
  'removed-incomplete-member': 'Removed a truncated final member',
  'added-missing-comma': 'Inserted a missing comma',
  'added-missing-colon': 'Inserted a missing colon',
  'added-missing-value': 'Inserted null for a missing value',
  'added-closing-brace': 'Closed an unterminated object',
  'added-closing-bracket': 'Closed an unterminated array',
  'normalized-quotes': 'Converted non-standard quotes to double quotes',
  'normalized-literal': 'Rewrote a non-JSON literal',
  'normalized-number': 'Rewrote a non-JSON number',
  'quoted-key': 'Quoted an unquoted key',
  'quoted-value': 'Quoted an unquoted value',
  'escaped-character': 'Escaped a character that JSON forbids raw',
  'fixed-escape': 'Corrected an invalid escape sequence',
  'terminated-string-at-eof': 'Closed a string left open at end of input',
  'terminated-string-at-newline':
    'Closed a string at a line break, discarding the rest of the line',
};

/** Returns the default explanation for a repair type. */
export function describeRepair(type: RepairType): string {
  return MESSAGES[type];
}
