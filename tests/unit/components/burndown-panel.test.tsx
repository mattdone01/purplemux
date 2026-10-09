import { renderToStaticMarkup } from 'react-dom/server';
import { SWRConfig } from 'swr';
import { describe, expect, it } from 'vitest';
import BurndownPanel, { BurndownChart, BurndownPanelContent, stepPath } from '@/components/features/mission-control/burndown-panel';
import { BURNDOWN_STALE_MS } from '@/lib/burndown';
import type { IBurndownEpic, IBurndownHistoryRow, IMissionBurndownResponse } from '@/types/burndown';

const GENERATED = '2026-10-09T22:36:41Z';
const NOW = Date.parse(GENERATED) + 5 * 60_000;

const epic = (slug: string, overrides: Partial<IBurndownEpic> = {}): IBurndownEpic => ({
  slug, name: `${slug} name`, stories: 9, unpointed: 0, total: 16, burned: 8, remaining: 8, pct: 50,
  in_progress: 3, blocked: 0, done_events: [], undated_burned: 8, ...overrides,
});

const row = (slug: string, at: string, remaining: number, total = 16): IBurndownHistoryRow => ({
  at, slug, total, burned: total - remaining, remaining, pct: Math.round(((total - remaining) / total) * 1000) / 10,
  stories: 9, unpointed: 0,
});

const response = (epics: IBurndownEpic[], history: IBurndownHistoryRow[] = [], generatedAt = GENERATED): IMissionBurndownResponse => ({
  workspaceId: 'ws-sm',
  burndown: { workspaceId: 'ws-sm', receivedAt: Date.parse(generatedAt), snapshot: { generated_at: generatedAt, epics, history } },
});

const render = (props: Partial<Parameters<typeof BurndownPanelContent>[0]>) =>
  renderToStaticMarkup(<BurndownPanelContent loading={false} error={null} now={NOW} {...props} />);

describe('burndown panel states', () => {
  it('shows loading, then a read error with retry', () => {
    expect(render({ loading: true })).toContain('Loading burndown');
    const failed = render({ error: 'burndown storage unreadable: the file is not JSON' });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('burndown storage unreadable: the file is not JSON');
    expect(failed).toContain('Retry');
  });

  it('renders nothing before a Scrum Master is selected', () => {
    expect(render({ response: { workspaceId: null, burndown: null } })).toBe('');
  });

  it('names the publish command when nothing is published', () => {
    const html = render({ response: { workspaceId: 'ws-sm', burndown: null } });
    expect(html).toContain('No burndown published');
    expect(html).toContain('purplemux burndown publish -w ws-sm --json @burndown.json');
  });

  it('shows one epic with points, bar, counts and a chart', () => {
    const html = render({ response: response([epic('epic-a', { blocked: 1 })], [
      row('epic-a', '2026-10-09T10:00:00Z', 16), row('epic-a', '2026-10-09T16:00:00Z', 12), row('epic-a', GENERATED, 8),
    ]) });
    expect(html).toContain('epic-a name');
    expect(html).toContain('8 / 16 pts');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('8 remaining');
    expect(html).toContain('3 in progress');
    expect(html).toContain('1 blocked');
    expect(html).toContain('text-ui-red');
    expect(html).toContain('Remaining 8 of 16 points across 3 snapshots');
    expect(html).toContain('var(--ui-blue)');
    expect(html).toContain('var(--muted-foreground)');
    expect(html).not.toContain('Stale');
  });

  it('totals the fleet across many epics and hides epics without points', () => {
    const html = render({ response: response([
      epic('epic-a'),
      epic('epic-b', { total: 30, burned: 6, remaining: 24, pct: 20, blocked: 2, in_progress: 1, unpointed: 2 }),
      epic('epic-zero', { total: 0, burned: 0, remaining: 0, pct: 0, undated_burned: 0 }),
    ]) });
    expect(html).toContain('Fleet');
    expect(html).toContain('14 / 46 pts');
    expect(html).toContain('30.4%');
    expect(html).toContain('32 remaining');
    expect(html).toContain('2 epics');
    expect(html).toContain('1 epic without points hidden');
    expect(html).toContain('2 unpointed stories not counted');
    expect(html).not.toContain('epic-zero name');
    expect(html).toContain('No history yet');
  });

  it('says so when every epic lacks points', () => {
    const html = render({ response: response([epic('epic-zero', { total: 0, burned: 0, remaining: 0, pct: 0, undated_burned: 0 })]) });
    expect(html).toContain('No epic in the latest burndown has points');
    expect(html).not.toContain('Fleet');
  });

  it('marks a snapshot older than two hours as stale', () => {
    const fresh = render({ response: response([epic('epic-a')]), now: Date.parse(GENERATED) + BURNDOWN_STALE_MS });
    expect(fresh).not.toContain('Stale');
    const stale = render({ response: response([epic('epic-a')]), now: Date.parse(GENERATED) + BURNDOWN_STALE_MS + 60_000 });
    expect(stale).toContain('Stale');
    expect(stale).toContain('generated 2h 1m ago');
    expect(stale).toContain('text-ui-amber');
  });
});

describe('burndown chart', () => {
  it('draws step lines from the first to the last snapshot', () => {
    expect(stepPath([{ x: 0, y: 10 }, { x: 5, y: 6 }, { x: 9, y: 2 }])).toBe('M0 10H5V6H9V2');
    expect(stepPath([])).toBe('');
  });

  it('puts the endpoint dot on the latest remaining value', () => {
    const html = renderToStaticMarkup(<BurndownChart rows={[row('a', '2026-10-09T10:00:00Z', 16), row('a', GENERATED, 0)]} />);
    expect(html).toMatch(/<circle[^>]*cy="(\d+(\.\d+)?)"/);
    expect(html).toContain('Remaining 0 of 16 points across 2 snapshots');
  });

  it('draws a single snapshot as a dot without lines', () => {
    const html = renderToStaticMarkup(<BurndownChart rows={[row('a', GENERATED, 4)]} />);
    expect(html).toContain('<circle');
    expect(html).toContain('across 1 snapshot');
  });
});

describe('burndown panel through the SWR cache', () => {
  it('renders the cached response', () => {
    const html = renderToStaticMarkup(
      <SWRConfig value={{ provider: () => new Map(), fallback: { '/api/mission-control/burndown': response([epic('epic-a')]) } }}>
        <BurndownPanel />
      </SWRConfig>,
    );
    expect(html).toContain('epic-a name');
  });
});
