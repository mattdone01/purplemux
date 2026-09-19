import { describe, expect, it } from 'vitest';
import {
  PASTE_END,
  PASTE_START,
  TYPED_CHUNK_CHARS,
  isPathOnlyPaste,
  planTypedInput,
  splitBracketedPaste,
} from '@/lib/typed-input';

const typedBack = (content: string): string =>
  planTypedInput(content)
    .map((step) => (step.kind === 'newline' ? '\n' : step.text))
    .join('');

describe('planTypedInput', () => {
  it('types a single line as one text step', () => {
    expect(planTypedInput('fix the lint errors')).toEqual([{ kind: 'text', text: 'fix the lint errors' }]);
  });

  it('turns every newline flavour into a newline step, never into text', () => {
    expect(planTypedInput('a\nb\r\nc\rd')).toEqual([
      { kind: 'text', text: 'a' },
      { kind: 'newline' },
      { kind: 'text', text: 'b' },
      { kind: 'newline' },
      { kind: 'text', text: 'c' },
      { kind: 'newline' },
      { kind: 'text', text: 'd' },
    ]);
  });

  it('keeps blank lines', () => {
    expect(planTypedInput('a\n\nb').filter((step) => step.kind === 'newline')).toHaveLength(2);
    expect(typedBack('a\n\nb')).toBe('a\n\nb');
  });

  it('never emits a burst above the chunk ceiling, and loses no text', () => {
    const line = 'word '.repeat(1000);
    const steps = planTypedInput(line);
    expect(steps.length).toBe(Math.ceil(line.length / TYPED_CHUNK_CHARS));
    for (const step of steps) {
      expect(step.kind).toBe('text');
      if (step.kind === 'text') expect(Array.from(step.text).length).toBeLessThanOrEqual(TYPED_CHUNK_CHARS);
    }
    expect(typedBack(line)).toBe(line);
  });

  it('does not split a surrogate pair across chunks', () => {
    const line = '😀'.repeat(TYPED_CHUNK_CHARS + 1);
    const steps = planTypedInput(line);
    expect(steps).toHaveLength(2);
    expect(typedBack(line)).toBe(line);
    for (const step of steps) {
      if (step.kind === 'text') expect(step.text).toMatch(/^(?:😀)+$/u);
    }
  });

  it('types a tab as spaces and drops other control characters', () => {
    expect(typedBack('\tkey:\x1b value\x03\x7f')).toBe('    key: value');
  });

  it('plans nothing for empty content', () => {
    expect(planTypedInput('')).toEqual([]);
  });
});

describe('splitBracketedPaste', () => {
  it('is null for input that carries no complete paste', () => {
    expect(splitBracketedPaste('plain')).toBeNull();
    expect(splitBracketedPaste(`${PASTE_START}unterminated`)).toBeNull();
    expect(splitBracketedPaste(`stray${PASTE_END}`)).toBeNull();
  });

  it('separates the paste body from what surrounds it', () => {
    expect(splitBracketedPaste(`ab${PASTE_START}line 1\nline 2${PASTE_END}\r`)).toEqual({
      before: 'ab',
      body: 'line 1\nline 2',
      after: '\r',
    });
  });

  it('takes the first paste and leaves a second one in `after`', () => {
    const second = `${PASTE_START}two${PASTE_END}`;
    expect(splitBracketedPaste(`${PASTE_START}one${PASTE_END}${second}`)).toEqual({
      before: '',
      body: 'one',
      after: second,
    });
  });
});

describe('isPathOnlyPaste', () => {
  it.each([
    '/home/me/shot.png',
    '/tmp/uploads/my\\ shot\\(1\\).png',
    '/tmp/a.png /tmp/b.png',
    '~/pictures/a.png',
    '\\~/pictures/a.png',
    '  /tmp/a.png  ',
  ])('keeps %j a paste', (body) => {
    expect(isPathOnlyPaste(body)).toBe(true);
  });

  it.each([
    '',
    '/clear',
    'look at /tmp/a.png',
    '/tmp/a.png then fix it',
    '/tmp/a.png\n/tmp/b.png',
    'implement pft-1363',
  ])('types %j', (body) => {
    expect(isPathOnlyPaste(body)).toBe(false);
  });
});
