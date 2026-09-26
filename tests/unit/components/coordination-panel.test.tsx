import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CoordinationPanelView, formatAge } from '@/components/features/mission-control/coordination-panel';
import type { ICoordinationSnapshot } from '@/types/coordination';

// Story 20: each section's empty, populated and error states; the AC warnings.

const AT = Date.parse('2026-09-26T15:00:00Z');
const empty = (): ICoordinationSnapshot => ({
  at: AT,
  leases: { ok: true, items: [] }, notes: { ok: true, items: [] }, watches: { ok: true, items: [] },
  grants: { ok: true, items: [] }, inboxHeld: { ok: true, items: [] },
  host: { available: true, disks: [{ path: '/', usedPct: 40, freeBytes: 500 * 1024 ** 3, inodesUsedPct: 10 }], tmpInodesUsedPct: 20, loadAverage: [1, 2, 3], memAvailableBytes: 8 * 1024 ** 3 },
  signals: { state: 'not-configured' },
});
const render = (snapshot: ICoordinationSnapshot | null, error: string | null = null, loading = false) =>
  renderToStaticMarkup(<CoordinationPanelView snapshot={snapshot} error={error} loading={loading} />);
const sectionHtml = (html: string, title: string) => html.slice(html.indexOf(`data-section="${title}"`), html.indexOf('</div>', html.indexOf(`data-section="${title}"`)));

describe('coordination panel', () => {
  it.each(['Leases', 'Open notes', 'Watches', 'Grants', 'Held deliveries'])('%s: empty state', (title) => {
    expect(sectionHtml(render(empty()), title)).toContain('data-state="empty"');
  });

  it.each([
    ['Leases', 'leases'], ['Open notes', 'notes'], ['Watches', 'watches'], ['Grants', 'grants'], ['Held deliveries', 'inboxHeld'],
  ] as const)('%s: error state shows the served error', (title, key) => {
    const snap = { ...empty(), [key]: { ok: false, error: `${key} store unreadable` } } as ICoordinationSnapshot;
    const html = sectionHtml(render(snap), title);
    expect(html).toContain('data-state="error"');
    expect(html).toContain(`${key} store unreadable`);
  });

  it('a lease whose holder tab closed shows "closed" in the warning style (not hidden); agent gone too', () => {
    const snap = empty();
    const lease = (name: string, holderState: string) => ({
      name, kind: 'merge', resource: 'x/y', holder: { workspaceId: 'ws-1', workspaceName: 'Portfolio', tabId: 'tab-a', tabName: 'worker', verified: true, admin: false },
      epic: null, note: null, acquiredAt: '', renewedAt: '', expiresAt: null, ttlSeconds: null, survivesTab: false,
      ageSeconds: 90, expiresInSeconds: null, holderState,
    });
    snap.leases = { ok: true, items: [lease('merge:x/y', 'closed'), lease('merge:x/z', 'live'), lease('merge:x/q', 'something-new')] } as ICoordinationSnapshot['leases'];
    const html = render(snap);
    expect(html).toMatch(/data-lease="merge:x\/y" data-holder-state="closed".*?<span class="text-ui-amber">closed<\/span>/);
    expect(html).toMatch(/data-lease="merge:x\/z".*?<span class="">live<\/span>/);
    // An unmapped state reads a neutral word, never the raw token.
    expect(html).not.toContain('>something-new<');
    expect(html).toMatch(/data-lease="merge:x\/q".*?>other</);
  });

  it('a 99 % disk is in the warning state; 40 % is not', () => {
    const snap = empty();
    expect(render(snap)).not.toContain('data-warn="true"');
    if (snap.host.available) snap.host.disks[0].usedPct = 99;
    expect(render(snap)).toMatch(/data-disk="\/" data-warn="true".*?<span class="text-ui-amber">disk 99%/);
  });

  it('host signals: not configured, validation error, values with stamp, stale', () => {
    expect(render(empty())).toContain('Host signals: not configured');
    const err = { ...empty(), signals: { state: 'error', error: 'invalid: tmpInodesPct — Required', ranAt: AT - 60_000, stale: false } } as ICoordinationSnapshot;
    expect(render(err)).toMatch(/data-signals="error".*invalid: tmpInodesPct — Required · run 1m ago/);
    const ok = { ...empty(), signals: { state: 'ok', ranAt: AT - 120_000, stale: false, value: { schemaVersion: 1, stampedAt: AT - 130_000, gateSlots: { total: 6, held: 2, holders: [] }, worktrees: [{ repo: 'treasury-ui', count: 374, byEpic: {} }], tmpInodesPct: 41.2 } } } as ICoordinationSnapshot;
    expect(render(ok)).toMatch(/data-signals="ok".*gate slots 2\/6 held · 374 worktrees \(treasury-ui 374\) · \/tmp inodes 41.2%/);
    const stale = { ...ok, signals: { ...ok.signals, stale: true } } as ICoordinationSnapshot;
    expect(render(stale)).toContain('(stale)');
  });

  it('host unavailable (not Linux) says why; no snapshot says loading or the error, never an empty panel', () => {
    expect(render({ ...empty(), host: { available: false, reason: 'host metrics are Linux only (this host is darwin)' } })).toContain('Linux only');
    expect(render(null, null, true)).toContain('Loading coordination');
    expect(render(null, 'Authentication required')).toContain('Coordination unavailable: Authentication required');
  });

  it('watches and held deliveries show labels, never the raw tokens', () => {
    const snap = empty();
    snap.watches = { ok: true, items: [{ id: 'w-1', workspaceId: 'ws-1', tabId: 'tab-a', kind: 'pr', target: 'NomuPay/x#1', until: 'head-moved', ageSeconds: 60, expiresInSeconds: 600, owner: 'closed' }] } as unknown as ICoordinationSnapshot['watches'];
    snap.inboxHeld = { ok: true, items: [{ id: 'i-1', kind: 'resume', targetWorkspaceId: 'ws-1', targetTabId: 'tab-a', heldReason: 'stranded-in-composer' }] } as unknown as ICoordinationSnapshot['inboxHeld'];
    const html = render(snap);
    expect(html).toContain('(PR) until head moved');
    expect(html).not.toContain('head-moved');
    expect(html).toMatch(/owner closed/);
    expect(html).toContain('resume → ws-1/tab-a');
  });

  it('formats ages', () => {
    expect([formatAge(5), formatAge(90), formatAge(7200), formatAge(200_000), formatAge(null)]).toEqual(['5s', '1m', '2h', '2d', '—']);
  });
});
