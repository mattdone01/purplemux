import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import terminal from '../../../messages/en/terminal.json';
import orchestration from '../../../messages/en/orchestration.json';
import grants from '../../../messages/en/grants.json';
import PaneTabItem from '@/components/features/workspace/pane-tab-item';
import type { ITab } from '@/types/terminal';

// ADR-0028: the tab menu that carries Restart exists for every tab the server can restart
// (agent and terminal tabs), and not for a panel it refuses (web-browser, diff, agent-sessions).

vi.mock('@/components/features/workspace/tab-status-indicator', () => ({ default: () => <span data-status-indicator="1" /> }));
vi.mock('@/components/features/workspace/grant-badge', () => ({ default: () => null }));

const render = (panelType: ITab['panelType']) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ terminal, orchestration, grants }}>
    <PaneTabItem
      tab={{ id: 'tab-t', sessionName: 's', name: 'worker', order: 0, ...(panelType ? { panelType } : {}) }}
      isActive
      isDragging={false}
      dropSide={null}
      onSwitch={() => {}}
      onDelete={() => {}}
      onRename={() => {}}
      onFocusPane={() => {}}
      onDragStart={() => {}}
      onDragEnd={() => {}}
      onDragOver={() => {}}
      onDragLeave={() => {}}
    />
  </NextIntlClientProvider>,
);

const hasMenuTrigger = (html: string) => /data-slot="context-menu-trigger"|data-popup-open|aria-haspopup/.test(html);

describe('the tab menu with Restart (ADR-0028)', () => {
  it.each(['claude-code', 'codex-cli', 'grok-cli', 'terminal', undefined] as const)('a %s tab has the menu', (panelType) => {
    const html = render(panelType);
    expect(hasMenuTrigger(html)).toBe(true);
    expect(html).toContain('data-status-indicator="1"');
    expect(html).toContain('aria-busy="false"');
  });

  it.each(['web-browser', 'diff', 'agent-sessions'] as const)('a %s tab has no restart menu', (panelType) => {
    expect(hasMenuTrigger(render(panelType))).toBe(false);
  });

  it('every locale names both menu items and the restarting state', async () => {
    const fs = await import('fs/promises');
    const locales = await fs.readdir('messages');
    for (const locale of locales) {
      const messages = JSON.parse(await fs.readFile(`messages/${locale}/terminal.json`, 'utf-8')) as Record<string, string>;
      for (const key of ['restartTab', 'restartTabFresh', 'restartingTab', 'tabRestarted', 'tabRestartedFresh']) {
        expect(typeof messages[key], `${locale}/${key}`).toBe('string');
      }
    }
  });
});
