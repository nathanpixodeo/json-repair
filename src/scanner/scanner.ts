import { CH_CARRIAGE_RETURN, CH_EOF, CH_LINE_FEED } from './tokens.js';

/** A one-based line/column pair, resolved against the original input. */
export interface SourcePosition {
  line: number;
  column: number;
}

/**
 * A cursor over a bounded region of the original input.
 *
 * Extraction never copies: it narrows {@link Scanner.start} and leaves
 * {@link Scanner.source} pointing at the caller's original string. Every offset
 * the engine reports is therefore already absolute, so repair positions stay
 * meaningful even when the JSON was buried in prose.
 *
 * Line and column numbers are derived from an index of line starts that is
 * built on first use. Malformed input that produces no diagnostics never pays
 * for it.
 */
export class Scanner {
  /** The original, uncut input. */
  readonly source: string;

  /** First offset of the region being parsed. */
  readonly start: number;

  /** Offset one past the last character of the region. */
  readonly end: number;

  /** Current offset. Always within `[start, end]`. */
  index: number;

  /** Offsets at which each line begins; built lazily by {@link positionAt}. */
  private lineStarts: number[] | undefined;

  constructor(source: string, start = 0, end = source.length) {
    this.source = source;
    this.start = start;
    this.end = end;
    this.index = start;
  }

  /** Reports whether the cursor has reached the end of the region. */
  eof(): boolean {
    return this.index >= this.end;
  }

  /** Returns the code unit at the cursor, or {@link CH_EOF} at the end. */
  peek(): number {
    return this.index < this.end ? this.source.charCodeAt(this.index) : CH_EOF;
  }

  /** Returns the text between two absolute offsets. */
  slice(from: number, to: number): string {
    return this.source.slice(from, to);
  }

  /**
   * Resolves an absolute offset to a one-based line and column.
   *
   * `\n`, `\r\n` and a lone `\r` all end a line. U+2028 and U+2029 do not:
   * JSON treats them as ordinary string content, and counting them would make
   * positions disagree with what an editor shows.
   */
  positionAt(offset: number): SourcePosition {
    const starts = this.lineStarts ?? (this.lineStarts = buildLineStarts(this.source));

    // Binary search for the last line start at or before `offset`.
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >>> 1;
      if (starts[mid]! <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }

    return { line: low + 1, column: offset - starts[low]! + 1 };
  }
}

/** Computes the offset at which each line of `source` begins. */
function buildLineStarts(source: string): number[] {
  const starts: number[] = [0];
  const length = source.length;

  for (let index = 0; index < length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === CH_CARRIAGE_RETURN) {
      // Treat CRLF as a single break so a column is never counted twice.
      if (index + 1 < length && source.charCodeAt(index + 1) === CH_LINE_FEED) {
        index += 1;
      }
      starts.push(index + 1);
    } else if (code === CH_LINE_FEED) {
      starts.push(index + 1);
    }
  }

  return starts;
}
