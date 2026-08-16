import { describe, expect, it } from 'vitest';
import { decodesLosslessly, sliceFromNextLine, splitCompleteLines } from '@/lib/buffer-lines';

/**
 * The reviewer's reproduction: a first line of four `中` (3 bytes each) plus the
 * newline is 21 bytes, so every read that starts inside it must report 21 as the
 * offset of the second line. Measuring the discarded prefix on the decoded
 * string charged each orphaned continuation byte 3 bytes as U+FFFD and returned
 * 23 or 25 instead.
 */
const FIRST_LINE = '中中中中';
const SECOND_LINE = '{"a":1}';
const FIXTURE = Buffer.from(`${FIRST_LINE}\n${SECOND_LINE}\n`, 'utf-8');
const TRUE_SECOND_LINE_OFFSET = Buffer.byteLength(`${FIRST_LINE}\n`, 'utf-8');

describe('sliceFromNextLine', () => {
  it('measures the discarded first line in bytes, at every offset inside it', () => {
    expect(TRUE_SECOND_LINE_OFFSET).toBe(13);

    const table = Array.from({ length: TRUE_SECOND_LINE_OFFSET }, (_, from) => {
      const slice = sliceFromNextLine(FIXTURE.subarray(from), from);
      return { from, validFrom: slice?.validFrom, content: slice?.content };
    });

    for (const row of table) {
      expect(row.validFrom, `read from byte ${row.from}`).toBe(TRUE_SECOND_LINE_OFFSET);
      expect(row.content, `read from byte ${row.from}`).toBe(`${SECOND_LINE}\n`);
    }
  });

  it('reproduces the exact offsets the reviewer executed', () => {
    const longer = Buffer.from(`${FIRST_LINE}${FIRST_LINE}\n${SECOND_LINE}\n`, 'utf-8');
    const trueOffset = Buffer.byteLength(`${FIRST_LINE}${FIRST_LINE}\n`, 'utf-8');
    expect(trueOffset).toBe(25);

    for (const from of [7, 8, 10]) {
      expect(sliceFromNextLine(longer.subarray(from), from)?.validFrom).toBe(trueOffset);
    }
  });

  it('returns the bytes after the newline, decoded from the newline boundary', () => {
    const buffer = Buffer.from('a\n😀 tail\n', 'utf-8');
    expect(sliceFromNextLine(buffer, 0)).toEqual({ content: '😀 tail\n', validFrom: 2 });
  });

  it('returns null when the window holds no newline', () => {
    expect(sliceFromNextLine(Buffer.from('no newline here', 'utf-8'), 40)).toBeNull();
    expect(sliceFromNextLine(Buffer.alloc(0), 0)).toBeNull();
  });

  it('reports the offset one past the newline when the newline is the last byte', () => {
    const buffer = Buffer.from('中\n', 'utf-8');
    expect(sliceFromNextLine(buffer, 100)).toEqual({ content: '', validFrom: 104 });
  });
});

const isJson = (line: string): boolean => {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
};

describe('decodesLosslessly', () => {
  it('accepts whole characters and rejects a truncated one', () => {
    const whole = Buffer.from('中文 😀', 'utf-8');

    expect(decodesLosslessly(whole)).toBe(true);
    expect(decodesLosslessly(whole.subarray(0, whole.length - 1))).toBe(false);
    expect(decodesLosslessly(whole.subarray(1))).toBe(false);
  });

  it('accepts bytes that genuinely spell U+FFFD', () => {
    expect(decodesLosslessly(Buffer.from('a \uFFFD b', 'utf-8'))).toBe(true);
  });
});

describe('splitCompleteLines', () => {
  it('keeps the trailing partial record as raw bytes', () => {
    const bytes = Buffer.from('{"a":1}\n{"b":2', 'utf-8');
    const { content, pending } = splitCompleteLines(bytes, isJson);

    expect(content).toBe('{"a":1}\n');
    expect(pending.toString('utf-8')).toBe('{"b":2');
  });

  it('emits a complete record that has not got its newline yet', () => {
    const bytes = Buffer.from('{"a":1}\n{"b":2}', 'utf-8');
    const { content, pending } = splitCompleteLines(bytes, isJson);

    expect(content).toBe('{"a":1}\n{"b":2}');
    expect(pending).toHaveLength(0);
  });

  it('holds back a record with a torn character even though its text parses', () => {
    const whole = Buffer.from('{"a":"中"}', 'utf-8');
    // U+FFFD is legal inside a JSON string, so a record whose character was cut
    // in half still parses — and would be emitted carrying destroyed text.
    const torn = Buffer.concat([
      Buffer.from('{"a":"', 'utf-8'),
      Buffer.from('中', 'utf-8').subarray(0, 2),
      Buffer.from('"}', 'utf-8'),
    ]);
    expect(isJson(torn.toString('utf-8'))).toBe(true);

    expect(splitCompleteLines(whole, isJson).pending).toHaveLength(0);
    expect(splitCompleteLines(torn, isJson).content).toBe('');
    expect(splitCompleteLines(torn, isJson).pending.equals(torn)).toBe(true);
  });

  it('carries the whole window when it holds no newline and no finished record', () => {
    const bytes = Buffer.from('{"a":1', 'utf-8');
    const { content, pending } = splitCompleteLines(bytes, isJson);

    expect(content).toBe('');
    expect(pending.equals(bytes)).toBe(true);
  });

  it('returns everything and nothing pending when the window ends on a newline', () => {
    const bytes = Buffer.from('{"a":1}\n{"b":2}\n', 'utf-8');
    const { content, pending } = splitCompleteLines(bytes, isJson);

    expect(content).toBe('{"a":1}\n{"b":2}\n');
    expect(pending).toHaveLength(0);
  });
});
