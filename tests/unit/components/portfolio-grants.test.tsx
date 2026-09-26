import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';
import grants from '../../../messages/en/grants.json';
import PortfolioGrantsPanel, { type IPortfolioGrantsPanelProps } from '@/components/features/workspace/portfolio-grants-panel';
import { GrantBadgeView } from '@/components/features/workspace/grant-badge';
import type { IGrant, IGrantee } from '@/types/grant';

// Story 28: every state of the grant dialog and the badge, rendered statically.

const NOW = Date.parse('2026-09-26T14:00:00Z');
const grantees: IGrantee[] = [
  { workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-orch', name: 'orchestrator', panelType: 'claude-code', identity: 'launch' },
  { workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-old', name: 'old worker', panelType: 'claude-code', identity: 'hook' },
  { workspaceId: 'ws-2', workspaceName: 'Billing', tabId: 'tab-x', name: 'shell', panelType: 'terminal', identity: 'none' },
];
const active: IGrant = {
  id: 'g-live1', capability: 'drive', grantee: { workspaceId: 'ws-1', tabId: 'tab-orch' }, workspaces: ['ws-2', 'ws-3'], reason: 'r',
  createdAt: NOW - 1, createdBy: 'human', expiresAt: NOW + 3_600_000, revokedAt: null, revokedBy: null, revokeReason: null, expiryNotedAt: null,
};
const names = { 'ws-1': 'Portfolio', 'ws-2': 'Billing', 'ws-3': 'Treasury' };

const panel = (over: Partial<IPortfolioGrantsPanelProps> = {}) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
    <PortfolioGrantsPanel
      available grantees={grantees} grants={[]} workspaceNames={names} now={NOW}
      granteeKey={null} onGranteeChange={vi.fn()} workspaces={[]} onWorkspacesChange={vi.fn()}
      expiresInHours={24} onExpiryChange={vi.fn()} reason="" onReasonChange={vi.fn()} password="" onPasswordChange={vi.fn()}
      error={null} submitting={false} revokingId={null} onSubmit={vi.fn()} onRevoke={vi.fn()}
      {...over}
    />
  </NextIntlClientProvider>,
);

describe('portfolio grants dialog content', () => {
  it('lists unverified tabs disabled with the recreate hint; a launch tab is selectable', () => {
    const html = panel();
    const row = (key: string) => html.slice(html.indexOf(`data-grantee="${key}"`), html.indexOf('</label>', html.indexOf(`data-grantee="${key}"`)));
    expect(row('ws-1/tab-orch')).not.toContain('data-disabled');
    expect(row('ws-1/tab-orch')).not.toContain('Recreate the tab to grant');
    for (const key of ['ws-1/tab-old', 'ws-2/tab-x']) {
      expect(row(key)).toContain('data-disabled="true"');
      expect(row(key)).toContain('Recreate the tab to grant');
    }
  });

  it('offers only other workspaces than the grantee\'s own', () => {
    const html = panel({ granteeKey: 'ws-1/tab-orch' });
    expect(html).toContain('data-target="ws-2"');
    expect(html).toContain('data-target="ws-3"');
    expect(html).not.toContain('data-target="ws-1"');
  });

  it('lists an active grant with its workspaces, expiry and a Revoke button; revoked and expired ones are gone', () => {
    const html = panel({ grants: [active, { ...active, id: 'g-rev1', revokedAt: NOW - 1 }, { ...active, id: 'g-exp1', expiresAt: NOW }] });
    expect(html).toContain('data-grant="g-live1"');
    expect(html).toContain('drives Billing, Treasury');
    expect(html).toContain('Revoke');
    expect(html).not.toContain('g-rev1');
    expect(html).not.toContain('g-exp1');
    expect(panel()).toContain('No active grants');
  });

  it('shows the served refusal text it is given, and the create button stays disabled without a password', () => {
    const html = panel({ error: 'Wrong password: the purplemux password is wrong or missing' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Wrong password: the purplemux password is wrong or missing');
    expect(panel({ granteeKey: 'ws-1/tab-orch', workspaces: ['ws-2'], reason: 'r' })).toMatch(/<button[^>]*disabled[^>]*>Create grant/);
  });

  it('while loading or after a failed read, the lists are unknown (—), never "none"', () => {
    const html = panel({ available: false, grantees: [], error: 'Could not load the grants — Your session has expired — log in again' });
    expect(html).toContain('data-unavailable="grantees"');
    expect(html).toContain('data-unavailable="grants"');
    expect(html).not.toContain('No tabs to grant');
    expect(html).not.toContain('No active grants');
    expect(html).toContain('Your session has expired');
  });

  it('says so when there are no tabs to grant', () => {
    expect(panel({ grantees: [] })).toContain('No tabs to grant');
  });
});

describe('grant badge', () => {
  it('shows "drives N" with the workspaces and the expiry in its label', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
        <GrantBadgeView badge={{ count: 2, workspaces: ['ws-2', 'ws-3'], expiresAt: NOW + 3_600_000 }} workspaceNames={names} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('drives 2');
    expect(html).toContain('data-grant-badge="2"');
    expect(html).toMatch(/aria-label="Drives Billing, Treasury until [^"]+"/);
  });
});
