import { describe, expect, it } from 'vitest';
import { createStdinTypedWriter } from '@/lib/stdin-typed-writer';
import { PASTE_END, PASTE_START, TYPED_CHUNK_CHARS } from '@/lib/typed-input';

const paste = (body: string): string => `${PASTE_START}${body}${PASTE_END}`;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
};

const harness = (typed: boolean) => {
  const writes: string[] = [];
  let lookups = 0;
  const writer = createStdinTypedWriter({
    write: (data) => writes.push(data),
    usesTyped: async () => {
      lookups += 1;
      return typed;
    },
    sleep: async () => {},
  });
  return { writes, writer, lookups: () => lookups };
};

describe('createStdinTypedWriter', () => {
  it('writes ordinary input straight through, without a panel lookup', () => {
    const { writes, writer, lookups } = harness(true);
    writer('a');
    writer('\r');
    expect(writes).toEqual(['a', '\r']);
    expect(lookups()).toBe(0);
  });

  it('replays a text paste as keystrokes with LF newlines and no paste markers', async () => {
    const { writes, writer } = harness(true);
    writer(paste('line one\nline two'));
    await flush();
    expect(writes).toEqual(['line one', '\n', 'line two']);
  });

  it('chunks a long paste below the burst ceiling', async () => {
    const { writes, writer } = harness(true);
    const body = 'x'.repeat(TYPED_CHUNK_CHARS * 3 + 1);
    writer(paste(body));
    await flush();
    expect(writes).toHaveLength(4);
    expect(Math.max(...writes.map((w) => w.length))).toBe(TYPED_CHUNK_CHARS);
    expect(writes.join('')).toBe(body);
  });

  it('holds input that arrives mid-replay behind the paste it follows', async () => {
    const { writes, writer } = harness(true);
    writer(paste('a\nb'));
    writer('\r');
    expect(writes).toEqual([]);
    await flush();
    expect(writes).toEqual(['a', '\n', 'b', '\r']);
  });

  it('returns to straight-through writes once the replay drains', async () => {
    const { writes, writer } = harness(true);
    writer(paste('a'));
    await flush();
    writer('z');
    expect(writes).toEqual(['a', 'z']);
  });

  it('keeps the bytes around a paste, and replays a second paste in the same message', async () => {
    const { writes, writer } = harness(true);
    writer(`x${paste('one')}y${paste('two')}\r`);
    await flush();
    expect(writes).toEqual(['x', 'one', 'y', 'two', '\r']);
  });

  it('leaves a paste untouched for a pane that does not want typed prompts', async () => {
    const { writes, writer } = harness(false);
    const data = paste('line one\nline two');
    writer(data);
    await flush();
    expect(writes).toEqual([data]);
  });

  it('leaves a path-only paste a paste, so an image path still attaches', async () => {
    const { writes, writer, lookups } = harness(true);
    const data = paste('/tmp/uploads/shot.png');
    writer(data);
    await flush();
    expect(writes).toEqual([data]);
    expect(lookups()).toBe(0);
  });

  it('writes the paste through unchanged when the panel lookup fails', async () => {
    const writes: string[] = [];
    const writer = createStdinTypedWriter({
      write: (data) => writes.push(data),
      usesTyped: async () => {
        throw new Error('layout unreadable');
      },
      sleep: async () => {},
    });
    writer(paste('a\nb'));
    writer('\r');
    await flush();
    expect(writes).toEqual([paste('a\nb'), '\r']);
  });
});
