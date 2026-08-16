const NEWLINE = 0x0a;

export interface IBufferLineSlice {
  /** Decoded text, starting at the first whole record in the window. */
  content: string;
  /** Absolute byte offset `content` starts at. */
  validFrom: number;
}

/**
 * Drops the partial record a read starting mid-file begins with, and reports
 * the absolute offset of what is left.
 *
 * The discarded prefix is measured on the Buffer, never on a decoded string. An
 * offset that lands inside a multi-byte character leaves orphaned continuation
 * bytes; each decodes to U+FFFD, which `Buffer.byteLength` charges at 3 bytes,
 * so a decoded measurement overshoots the true line start. Entries parsed from
 * such a chunk would carry a `seq` — and, for Codex, an `id` — that a whole-file
 * parse of the same record never produces.
 *
 * Returns null when the window holds no newline at all: the caller decides
 * whether that means "no whole record here" or "take the window as-is".
 */
export const sliceFromNextLine = (buffer: Buffer, from: number): IBufferLineSlice | null => {
  const newline = buffer.indexOf(NEWLINE);
  if (newline < 0) return null;
  return {
    content: buffer.subarray(newline + 1).toString('utf-8'),
    validFrom: from + newline + 1,
  };
};

/** The remainder of a read that held no whole record at all. */
export const EMPTY_PENDING = Buffer.alloc(0);

/**
 * True when the bytes decode without loss — no multi-byte character is cut in
 * half at either end.
 *
 * A torn character decodes to U+FFFD, and U+FFFD is legal inside a JSON string,
 * so a "complete" record can parse and still carry destroyed text. Re-encoding
 * is the only check that catches it, and bytes that genuinely hold U+FFFD
 * round-trip unchanged, which is the honest answer for them.
 */
export const decodesLosslessly = (bytes: Buffer): boolean =>
  Buffer.from(bytes.toString('utf-8'), 'utf-8').equals(bytes);

export interface ICompleteLines {
  /** Whole records, decoded — safe to parse and to measure by byte length. */
  content: string;
  /** Raw bytes of the trailing partial record, to carry into the next read. */
  pending: Buffer;
}

/**
 * Splits a streamed window into the records that are ready to parse and the
 * remainder to carry forward.
 *
 * The remainder stays a `Buffer`: an append can tear a multi-byte character in
 * half, and decoding the remainder first replaces its lead bytes with U+FFFD,
 * which the continuation bytes arriving next can never be rejoined with.
 *
 * A record whose JSON is already complete is emitted on the read that completed
 * it rather than waiting for its newline — the behaviour the live timeline has
 * always had — but only when its bytes decode losslessly, or that early emission
 * is exactly how a torn character escapes.
 */
export const splitCompleteLines = (
  bytes: Buffer,
  isCompleteRecord: (line: string) => boolean,
): ICompleteLines => {
  const lastNewline = bytes.lastIndexOf(NEWLINE);
  const tail = lastNewline >= 0 ? bytes.subarray(lastNewline + 1) : bytes;

  if (tail.length > 0 && decodesLosslessly(tail) && isCompleteRecord(tail.toString('utf-8'))) {
    return { content: bytes.toString('utf-8'), pending: EMPTY_PENDING };
  }

  return {
    content: lastNewline >= 0 ? bytes.subarray(0, lastNewline + 1).toString('utf-8') : '',
    pending: tail,
  };
};
