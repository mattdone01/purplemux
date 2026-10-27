import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import grants from '../../../messages/en/grants.json';
import PortfolioGrantsPanel, { type IPortfolioGrantsPanelProps } from '@/components/features/workspace/portfolio-grants-panel';
import GrantBadge, { OwnerBadgeView } from '@/components/features/workspace/grant-badge';
import type { IGrantsView } from '@/lib/grants-client';
import type { IGrant, IGrantee } from '@/types/grant';

// ADR-0029 / story 05: the "Owner session" choice in the grants dialog, the
// owner row among the active grants, and the owner badge on the grantee tab.

const NOW = Date.parse('2026-10-26T14:00:00Z');
const grantees: IGrantee[] = [
  { workspaceId: 'ws-1', workspaceName: 'Owner', tabId: 'tab-o', name: 'owner session', panelType: 'claude-code', identity: 'launch' },
  { workspaceId: 'ws-1', workspaceName: 'Owner', tabId: 'tab-old', name: 'old', panelType: 'claude-code', identity: 'hook' },
];
const ownerGrant: IGrant = {
  id: 'g-own1', capability: 'owner', grantee: { workspaceId: 'ws-1', tabId: 'tab-o' }, workspaces: ['*'], reason: 'r',
  createdAt: NOW - 1, createdBy: 'human', expiresAt: NOW + 3_600_000, revokedAt: null, revokedBy: null, revokeReason: null, expiryNotedAt: null,
};
const names = { 'ws-1': 'Owner', 'ws-2': 'Billing' };
const CREATE_DISABLED = /<button[^>]* disabled=""[^>]*>(<[^>]*>)*Create grant/;

const panel = (over: Partial<IPortfolioGrantsPanelProps> = {}) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
    <PortfolioGrantsPanel
      available grantees={grantees} granteesError={null} unreadableWorkspaceIds={[]} grants={[]} workspaceNames={names} now={NOW}
      capability="owner" onCapabilityChange={vi.fn()}
      granteeKey={null} onGranteeChange={vi.fn()} workspaces={[]} onWorkspacesChange={vi.fn()}
      expiresInHours={24} onExpiryChange={vi.fn()} reason="" onReasonChange={vi.fn()} password="" onPasswordChange={vi.fn()}
      error={null} submitting={false} revokingIds={[]} onSubmit={vi.fn()} onRevoke={vi.fn()}
      {...over}
    />
  </NextIntlClientProvider>,
);

describe('owner session in the grants dialog', () => {
  it('offers both kinds; the owner kind replaces the workspace list with "every workspace"', () => {
    const html = panel();
    expect(html).toContain('data-capability="drive"');
    expect(html).toContain('data-capability="owner"');
    expect(html).toContain('data-owner-scope=""');
    expect(html).toContain('Every workspace, including ones created later');
    expect(html).not.toContain('data-target=');
    expect(panel({ capability: 'drive', granteeKey: 'ws-1/tab-o' })).toContain('data-target="ws-2"');
  });

  it('enables Create for a launch grantee with a reason and a password and no workspace; never for a hook grantee', () => {
    const ready = { reason: 'owner session', password: 'pw' };
    expect(panel({ granteeKey: 'ws-1/tab-o', ...ready })).not.toMatch(CREATE_DISABLED);
    expect(panel({ granteeKey: 'ws-1/tab-old', ...ready })).toMatch(CREATE_DISABLED);
    expect(panel({ granteeKey: 'ws-1/tab-o', reason: 'owner session' })).toMatch(CREATE_DISABLED);
  });

  it('while an owner grant is active, says who holds it and keeps Create disabled', () => {
    const html = panel({ grants: [ownerGrant], granteeKey: 'ws-1/tab-o', reason: 'r', password: 'pw' });
    expect(html).toContain('data-owner-active="g-own1"');
    expect(html).toMatch(/owner session · Owner holds the owner session until [^<]+; revoke it first/);
    expect(html).toMatch(CREATE_DISABLED);
    // A read grant is still possible beside it.
    expect(panel({ grants: [ownerGrant], capability: 'drive', granteeKey: 'ws-1/tab-o', workspaces: ['ws-2'], reason: 'r', password: 'pw' }))
      .not.toMatch(CREATE_DISABLED);
  });

  it('while the grants are unknown, claims no active owner grant', () => {
    expect(panel({ available: false, grants: [ownerGrant] })).not.toContain('data-owner-active');
  });

  it('lists the owner grant as "owner session — reads every workspace" with Revoke, never as "reads *"', () => {
    const html = panel({ grants: [ownerGrant] });
    expect(html).toContain('data-grant="g-own1"');
    expect(html).toContain('data-grant-capability="owner"');
    expect(html).toContain('owner session — reads every workspace');
    expect(html).not.toContain('reads *');
    expect(html).toContain('Revoke');
  });
});

describe('a refused grant file in the dialog (ADR-0029 §1)', () => {
  const driveRefused = [{ capability: 'drive' as const, file: 'grants.json' as const, error: '/h/grants.json is malformed', code: 'grant-store-unreadable' as const }];

  it('drive refused: the owner row stays with Revoke, the refusal shows, read-grant Create is disabled, owner Create is not', () => {
    const ready = { granteeKey: 'ws-1/tab-o', reason: 'r', password: 'pw', workspaces: ['ws-2'] };
    const html = panel({ grants: [], refused: driveRefused, capability: 'drive', ...ready });
    expect(html).toContain('data-grant-refused="drive"');
    expect(html).toContain('Read grants are not honoured: grants.json cannot be read — /h/grants.json is malformed');
    expect(html).not.toContain('No active grants');
    expect(html).toMatch(CREATE_DISABLED);
    expect(panel({ grants: [], refused: driveRefused, capability: 'owner', ...ready })).not.toMatch(CREATE_DISABLED);
    const listed = panel({ grants: [ownerGrant], refused: driveRefused });
    expect(listed).toContain('data-grant="g-own1"');
    expect(listed).toContain('Revoke');
  });

  it('owner refused: no "holds the owner session" claim even if a stale owner record is passed', () => {
    const ownerRefused = [{ capability: 'owner' as const, file: 'owner-grants.json' as const, error: 'x', code: 'grant-store-unreadable' as const }];
    const html = panel({ grants: [ownerGrant], refused: ownerRefused, granteeKey: 'ws-1/tab-o', reason: 'r', password: 'pw' });
    expect(html).not.toContain('data-owner-active');
    expect(html).toMatch(CREATE_DISABLED);
  });
});

describe('owner badge', () => {
  it('marks the owner tab with its expiry in the label', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
        <OwnerBadgeView expiresAt={NOW + 3_600_000} />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('data-owner-badge=""');
    expect(html).toContain('>owner<');
    expect(html).toMatch(/aria-label="Owner session: reads every workspace and sends notes as owner until [^"]+"/);
    expect(html).not.toContain('data-stale');
  });

  it('stays after a failed refresh, marked not refreshed with the reason', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
        <OwnerBadgeView expiresAt={NOW + 3_600_000} staleReason="Authentication required" />
      </NextIntlClientProvider>,
    );
    expect(html).toContain('data-stale="true"');
    expect(html).toContain('not refreshed: Authentication required');
  });
});

describe('GrantBadge with an owner grant, through the grants cache', () => {
  afterEach(() => vi.restoreAllMocks());

  const render = (grantsList: IGrant[], tabId: string) => {
    const fallback: IGrantsView = { grants: grantsList, grantees: [], unreadableWorkspaceIds: [], granteesError: null, skewMs: 0 };
    return renderToStaticMarkup(
      <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ grants }}>
        <SWRConfig value={{ provider: () => new Map() as never, fallback: { '/api/grants': fallback } }}>
          <GrantBadge workspaceId="ws-1" tabId={tabId} />
        </SWRConfig>
      </NextIntlClientProvider>,
    );
  };

  it('marks the owner tab with the owner badge only, and no other tab', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const html = render([ownerGrant], 'tab-o');
    expect(html).toContain('data-owner-badge=""');
    expect(html).not.toContain('data-grant-badge');
    expect(render([ownerGrant], 'tab-a')).toBe('');
  });

  it('shows both badges for an owner tab that also holds a read grant', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const read: IGrant = { ...ownerGrant, id: 'g-read1', capability: 'drive', workspaces: ['ws-2'] };
    const html = render([ownerGrant, read], 'tab-o');
    expect(html).toContain('data-owner-badge=""');
    expect(html).toContain('data-grant-badge="1"');
  });

  it('drops the owner badge once the grant expires', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 3_600_000);
    expect(render([ownerGrant], 'tab-o')).toBe('');
  });
});
