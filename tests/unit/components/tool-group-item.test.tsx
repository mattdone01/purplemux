import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import ToolGroupItem from '@/components/features/timeline/tool-group-item';
import type { ITimelineToolCall, ITimelineToolResult } from '@/types/timeline';
import timeline from '../../../messages/en/timeline.json';
import common from '../../../messages/en/common.json';

const call = (id: string, summary: string, status: ITimelineToolCall['status'] = 'success'): ITimelineToolCall => ({
  id, type: 'tool-call', toolUseId: id, timestamp: 0, toolName: 'exec', summary, status,
});
const render = (calls: ITimelineToolCall[], results: ITimelineToolResult[] = []) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ timeline, common }}>
    <ToolGroupItem toolCalls={calls} toolResults={results} />
  </NextIntlClientProvider>,
);

describe('collapsed tool activity', () => {
  it('shows the actual latest action without opening the group', () => {
    const html = render([call('c1', '$ git status'), call('c2', '$ pnpm test')]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('$ pnpm test');
    expect(html).toContain('2 tool calls');
    expect(html).not.toContain('$ git status');
  });

  it('prioritizes a running action over the last completed call', () => {
    const html = render([call('c1', '$ pnpm build', 'pending'), call('c2', '$ git status')]);
    expect(html).toContain('$ pnpm build');
    expect(html).toContain('running');
    expect(html).not.toContain('$ git status');
  });

  it('uses a streamed result to clear pending and keeps failures visible', () => {
    const html = render([call('c1', '$ pnpm test', 'pending'), call('c2', '$ git status')], [{
      id: 'r1', type: 'tool-result', timestamp: 1, toolUseId: 'c1', isError: true, summary: 'Tests failed',
    }]);
    expect(html).toContain('$ pnpm test');
    expect(html).toContain('An error occurred');
    expect(html).not.toContain('running');
  });

  it('uses singular counts and escapes source text', () => {
    const html = render([call('c1', '<script>alert(1)</script>')]);
    expect(html).toContain('1 tool call');
    expect(html).not.toContain('1 tool calls');
    expect(html).not.toContain('<script>');
  });
});
