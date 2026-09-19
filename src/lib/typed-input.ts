/**
 * Claude Code wraps a bracketed paste — and any single input burst of roughly
 * 800 characters or more — in `<pasted_content>` and treats it as untrusted
 * data rather than as the operator's prompt. A prompt composed in purplemux is
 * the operator's own text, so it is delivered as keystrokes instead: short
 * chunks, with Ctrl+J (LF) standing in for each newline.
 *
 * Measured against Claude Code 2.1.278: 200-character chunks spaced 10 ms apart
 * arrive byte-exact and unwrapped at 5 KB; a single 1,000-character burst is
 * wrapped.
 */
export const TYPED_CHUNK_CHARS = 200;
export const TYPED_CHUNK_GAP_MS = 10;

export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

export type TTypedStep = { kind: 'text'; text: string } | { kind: 'newline' };

const TAB_AS_SPACES = '    ';

// A control character typed into a composer is a key press, not text: Tab
// cycles a menu, Escape cancels the turn.
const sanitizeLine = (line: string): string =>
  line.replace(/\t/g, TAB_AS_SPACES).replace(/[\x00-\x1f\x7f]/g, '');

const chunkLine = (line: string): string[] => {
  const points = Array.from(line);
  const chunks: string[] = [];
  for (let i = 0; i < points.length; i += TYPED_CHUNK_CHARS) {
    chunks.push(points.slice(i, i + TYPED_CHUNK_CHARS).join(''));
  }
  return chunks;
};

export const planTypedInput = (content: string): TTypedStep[] => {
  const steps: TTypedStep[] = [];
  content.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index > 0) steps.push({ kind: 'newline' });
    for (const text of chunkLine(sanitizeLine(line))) steps.push({ kind: 'text', text });
  });
  return steps;
};

export interface IBracketedPasteSplit {
  before: string;
  body: string;
  after: string;
}

/** Null unless `data` carries one complete bracketed paste. */
export const splitBracketedPaste = (data: string): IBracketedPasteSplit | null => {
  const start = data.indexOf(PASTE_START);
  if (start === -1) return null;
  const bodyStart = start + PASTE_START.length;
  const end = data.indexOf(PASTE_END, bodyStart);
  if (end === -1) return null;
  return {
    before: data.slice(0, start),
    body: data.slice(bodyStart, end),
    after: data.slice(end + PASTE_END.length),
  };
};

const PATH_TOKEN = /^(?:\\?~)?\/[^/]+\/.+/;

/**
 * A paste that is nothing but file paths — an attachment, a dropped file. It
 * stays a paste: Claude Code turns a pasted image path into an attachment and
 * does no such thing for a typed one, and a path is data either way.
 */
export const isPathOnlyPaste = (body: string): boolean => {
  const trimmed = body.trim();
  if (trimmed === '' || /[\r\n]/.test(trimmed)) return false;
  const tokens = trimmed.match(/(?:\\.|[^\s\\])+/g) ?? [];
  return tokens.length > 0 && tokens.every((token) => PATH_TOKEN.test(token));
};
