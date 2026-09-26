import type { TPanelType } from '@/types/terminal';

// `tab result` (L7): an idle agent shows a DIM prompt suggestion on its composer
// line ("Billing cleared: re-run the listed runs and continue M2", measured
// 2026-09-26 in five ws-fOvEfz tabs). A plain `capture-pane -p` drops the SGR
// attributes, so the suggestion read as text the owner had typed but not sent.
// The pane is captured with escapes (`-e -J`); on the composer line and the
// lines after it, text rendered dim (SGR 2) is marked `[suggestion] …`; every
// other escape is stripped.

export type TResultMode = 'default' | 'no-suggestions' | 'raw';

interface ISegment {
  text: string;
  dim: boolean;
}

// CSI (ESC [ … final), OSC (ESC ] … BEL / ST), and two-character escapes.
const ESCAPE = /\x1b\[([0-9;:?]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** Split one line into text runs, tracking only dim (SGR 2 on, 22 or 0 off). */
export const parseSgrLine = (line: string, dimAtStart = false): { segments: ISegment[]; dimAtEnd: boolean } => {
  const segments: ISegment[] = [];
  let dim = dimAtStart;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const prev = segments.at(-1);
    if (prev && prev.dim === dim) prev.text += text;
    else segments.push({ text, dim });
  };
  for (const match of line.matchAll(ESCAPE)) {
    push(line.slice(last, match.index));
    last = match.index! + match[0].length;
    if (match[2] !== 'm') continue;
    // `;` separates parameters; `:` separates a parameter's own sub-parameters
    // (`4:2` is double underline, `38:5:2` a colour), so only a group's head is an attribute.
    const params = match[1] === '' ? ['0'] : match[1].split(';');
    for (let i = 0; i < params.length; i++) {
      const group = params[i];
      const p = group.split(':')[0];
      // 38/48/58 carry a colour: in `;` form the arguments follow as separate
      // parameters and are skipped, so their numbers are not read as attributes.
      if (p === '38' || p === '48' || p === '58') {
        if (!group.includes(':')) i += params[i + 1] === '5' ? 2 : params[i + 1] === '2' ? 4 : 0;
        continue;
      }
      if (p === '0' || p === '') dim = false;
      else if (p === '2') dim = true;
      else if (p === '22') dim = false;
    }
  }
  push(line.slice(last));
  return { segments, dimAtEnd: dim };
};

const stripEscapes = (line: string): string => line.replace(ESCAPE, '');

const COMPOSER_MARKER: Partial<Record<TPanelType, RegExp>> = {
  'claude-code': /^[ \t]*❯/,
  'codex-cli': /^[ \t]*›/,
  'grok-cli': /^[ \t]*[›❯>]/,
};

/** Index of the last line carrying the provider's composer marker, or -1. */
export const composerLineIndex = (lines: string[], panelType: TPanelType | undefined): number => {
  const marker = panelType ? COMPOSER_MARKER[panelType] : undefined;
  if (!marker) return -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (marker.test(stripEscapes(lines[i]))) return i;
  }
  return -1;
};

export interface IPaneResult {
  content: string;
  /** The dim suggestion on the composer line, or null. */
  suggestion: string | null;
}

/**
 * Render a pane captured with `-e -J`. `raw` returns it untouched; otherwise
 * escapes are stripped, and from the composer line down, dim text becomes
 * `[suggestion] <text>` (or is dropped with `no-suggestions`). A pane with no
 * composer line (a shell, a trust prompt) has nothing marked.
 */
export const renderPaneResult = (captured: string, panelType: TPanelType | undefined, mode: TResultMode = 'default'): IPaneResult => {
  const lines = captured.split('\n');
  const from = composerLineIndex(lines, panelType);
  let suggestion: string | null = null;
  let dimCarry = false;
  if (mode === 'raw') {
    // The same suggestion as the default mode: dim carried over from the lines above counts.
    for (let i = 0; i <= from; i++) {
      const { segments, dimAtEnd } = parseSgrLine(lines[i], dimCarry);
      dimCarry = dimAtEnd;
      if (i === from) suggestion = segments.filter((s) => s.dim).map((s) => s.text).join('').trim() || null;
    }
    return { content: captured, suggestion };
  }
  const out = lines.map((line, i) => {
    const { segments, dimAtEnd } = parseSgrLine(line, dimCarry);
    dimCarry = dimAtEnd;
    if (from === -1 || i < from) return segments.map((s) => s.text).join('');
    if (i === from) {
      const dim = segments.filter((s) => s.dim).map((s) => s.text).join('').trim();
      if (dim && mode !== 'no-suggestions') suggestion = dim;
    }
    return segments.map((s) => {
      if (!s.dim || !s.text.trim()) return s.text;
      return mode === 'no-suggestions' ? '' : `[suggestion] ${s.text.trim()}`;
    }).join('').replace(/[ \t ]+$/, '');
  });
  return { content: out.join('\n'), suggestion };
};
