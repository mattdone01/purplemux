import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import grants from '../../../messages/en/grants.json';
import GrantBadge, { GRANT_BADGE_TICK_MS } from '@/components/features/workspace/grant-badge';
import { GRANTS_POLL_MS } from '@/hooks/use-grants';
import { GrantsReadError, type IGrantsView } from '@/lib/grants-client';
import type { IGrant } from '@/types/grant';

// Story 28 review r3: the badge as mounted — through useGrants and the SWR cache —
// judges expiry on the server's clock, and a failed refresh keeps it, marked stale.

const CLIENT_NOW = 1_100_000;
const grant = { id: 'g-1', grantee: { workspaceId: 'ws-1', tabId: 'tab-a' }, workspaces: ['ws-2'], expiresAt: 1_050_000, revokedAt: null } as unknown as IGrant;
const view = (skewMs: number): IGrantsView => ({ grants: [grant], grantees: [], unreadableWorkspaceIds: [], granteesError: null, skewMs });

const render = (fallback: IGrantsView, error?: unknown) => {
  const cache = new Map<string, unknown>();
  if (error) cache.set('/api/grants', { data: fallback, error });
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
      <SWRConfig value={{ provider: () => cache as never, fallback: { '/api/grants': fallback } }}>
        <GrantBadge workspaceId="ws-1" tabId="tab-a" />
      </SWRConfig>
    </NextIntlClientProvider>,
  );
};

afterEach(() => vi.restoreAllMocks());

describe('GrantBadge through the grants cache', () => {
  it('ticks at most once per poll, so an expired grant loses its badge within one poll', () => {
    expect(GRANT_BADGE_TICK_MS).toBeLessThanOrEqual(GRANTS_POLL_MS);
  });

  it('shows a grant expired on the client clock but active on the server clock', () => {
    vi.spyOn(Date, 'now').mockReturnValue(CLIENT_NOW);
    expect(render(view(-100_000))).toContain('data-grant-badge="1"');
    // With no skew the same grant is expired: no badge.
    expect(render(view(0))).not.toContain('data-grant-badge');
  });

  it('keeps the badge after a failed refresh and labels the stale reason', () => {
    vi.spyOn(Date, 'now').mockReturnValue(CLIENT_NOW);
    const html = render(view(-100_000), new GrantsReadError({ status: 502, code: null, reason: 'bad gateway' }));
    expect(html).toContain('data-grant-badge="1"');
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('bad gateway');
    expect(html).not.toMatch(/not refreshed: 502/);
  });
});
