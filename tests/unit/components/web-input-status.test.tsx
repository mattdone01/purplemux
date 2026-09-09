import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import WebInputBar from '@/components/features/workspace/web-input-bar';
import type { TCliState } from '@/types/timeline';
import terminal from '../../../messages/en/terminal.json';
import common from '../../../messages/en/common.json';

const render = (connected: boolean, cliState: TCliState) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ terminal, common }}>
    <WebInputBar provider="codex" cliState={cliState} terminalWsConnected={connected}
      sendStdin={() => {}} visible focusTerminal={() => {}}
      focusInputRef={{ current: undefined }} setInputValueRef={{ current: undefined }} />
  </NextIntlClientProvider>,
);

describe('chat input status', () => {
  it('does not label a connected but inactive agent as connecting', () => {
    const html = render(true, 'inactive');
    expect(html).toContain('Codex session is not running');
    expect(html).not.toContain('Connecting...');
  });

  it('shows connection feedback when the terminal is disconnected, even if the agent is busy', () => {
    const html = render(false, 'busy');
    expect(html).toContain('Connecting...');
    expect(html).toContain('opacity-100');
  });
});
