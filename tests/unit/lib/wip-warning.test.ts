import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readCreateWip, splitCreateAnswer, wipWarningText } from '@/lib/wip-warning';
import type { ITab } from '@/types/terminal';

// ADR-0027: the human create answer's `wip`, read tolerantly, and the warning text.

const tab: ITab = { id: 'tab-1', name: 'claude', order: 0, sessionName: 's', panelType: 'claude-code' };

describe('wip warning', () => {
  it('splits wip off the tab so it never reaches the layout state', () => {
    const { tab: kept, wip } = splitCreateAnswer({ ...tab, wip: { count: 9, cap: 8, overCap: true } });
    expect(kept).toEqual(tab);
    expect(wip).toEqual({ count: 9, cap: 8, overCap: true });
    expect(splitCreateAnswer(tab)).toEqual({ tab, wip: null });
  });

  it('a malformed wip is no warning, never a warning about 0', () => {
    for (const bad of [null, 'x', {}, { count: '9', cap: 8, overCap: true }, { count: 9, cap: 8 }, { count: -1, cap: 8, overCap: false }, { count: 1.5, cap: 8, overCap: true }]) {
      expect(readCreateWip(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('warns only over the cap, naming the count and the cap', () => {
    const template = 'This workspace holds {count} agent tabs, over the WIP cap of {cap}';
    expect(wipWarningText(template, { count: 9, cap: 8, overCap: true })).toBe('This workspace holds 9 agent tabs, over the WIP cap of 8');
    expect(wipWarningText(template, { count: 8, cap: 8, overCap: false })).toBeNull();
  });

  it('every locale carries the warning with both placeholders', () => {
    const dir = path.resolve('messages');
    const locales = fs.readdirSync(dir);
    expect(locales.length).toBeGreaterThan(1);
    for (const locale of locales) {
      const text = JSON.parse(fs.readFileSync(path.join(dir, locale, 'terminal.json'), 'utf-8')).wipOverCap;
      expect(text, locale).toEqual(expect.stringContaining('{count}'));
      expect(text, locale).toEqual(expect.stringContaining('{cap}'));
    }
  });
});
