import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 20: GET /api/mission-control/coordination — the human session only; each
// section is read on its own, so one failing store shows its error, not a blank panel.

const m = vi.hoisted(() => ({
  leases: vi.fn(),
  notes: vi.fn(),
  watches: vi.fn(),
  refusal: null as string | null,
  grants: [] as unknown[],
  ownerRefusal: null as string | null,
  ownerGrants: [] as unknown[],
  inbox: vi.fn(),
  fleet: vi.fn(),
  announcements: vi.fn(),
}));

vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  verifySessionToken: vi.fn(async (token: string) => (token === 'good-session' ? { sub: 'human' } : null)),
}));
vi.mock('@/lib/lease-store', () => ({ listLeases: vi.fn(async () => [{ name: 'merge:x/y' }]) }));
vi.mock('@/lib/lease-http', () => ({ viewsOf: m.leases }));
vi.mock('@/lib/notes-store', () => ({
  readNotesState: m.notes,
  OPEN_STATES: new Set(['queued', 'delivered', 'undeliverable']),
  viewOf: (n: Record<string, unknown>) => ({ ...n }),
}));
vi.mock('@/lib/watch-manager', () => ({ getWatchManager: async () => ({ list: m.watches }) }));
// The two grant files (ADR-0029 §1), each failing alone, as listAllGrants reports them.
vi.mock('@/lib/grant-store', () => ({
  listAllGrants: () => {
    const files = [
      { capability: 'drive', file: 'grants.json', refusal: m.refusal, grants: m.grants },
      { capability: 'owner', file: 'owner-grants.json', refusal: m.ownerRefusal, grants: m.ownerGrants },
    ];
    const refused = files.filter((f) => f.refusal)
      .map((f) => ({ capability: f.capability, file: f.file, error: f.refusal, code: 'grant-store-unreadable' }));
    if (refused.length === files.length) return { ok: false, error: refused.map((r) => r.error).join('; ') };
    return { ok: true, grants: files.filter((f) => !f.refusal).flatMap((f) => f.grants), refused };
  },
  isActive: (g: { revokedAt: number | null; expiresAt: number }, now: number) => g.revokedAt === null && g.expiresAt > now,
}));
vi.mock('@/lib/inbox-store', () => ({ readInboxState: m.inbox }));
vi.mock('@/lib/fleet-status-snapshot', () => ({ readFleetView: m.fleet }));
// The real row builder over a mocked store, so no test reads ~/.purplemux/deploy-announcements.json.
vi.mock('@/lib/deploy-announce', async (importOriginal) => ({
  deployRowsOf: (await importOriginal<typeof import('@/lib/deploy-announce')>()).deployRowsOf,
  readAnnouncements: m.announcements,
}));
vi.mock('@/lib/host-metrics', () => ({ readHostMetrics: vi.fn(async () => ({ available: false, reason: 'test host' })) }));

const call = async (headers: Record<string, string>) => {
  const { default: handler } = await import('@/pages/api/mission-control/coordination');
  const state = { status: 0, body: undefined as unknown };
  const res = { status(c: number) { state.status = c; return this; }, json(b: unknown) { state.body = b; return this; }, setHeader() { return this; } } as unknown as NextApiResponse;
  await handler({ method: 'GET', headers, query: {}, socket: {} } as unknown as NextApiRequest, res);
  return state as { status: number; body: Record<string, { ok?: boolean; items?: unknown[]; error?: string; state?: string }> };
};

describe('GET /api/mission-control/coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.leases.mockResolvedValue([{ name: 'merge:x/y', holderState: 'closed' }]);
    m.notes.mockResolvedValue({ notes: [
      { id: 'n-1', state: 'delivered', createdAt: Date.now() - 60_000 },
      { id: 'n-2', state: 'acked', createdAt: Date.now() },
    ] });
    m.watches.mockResolvedValue([{ id: 'w-1' }]);
    m.refusal = null;
    m.grants = [{ id: 'g-1', revokedAt: null, expiresAt: Date.now() + 1000 }, { id: 'g-2', revokedAt: 1, expiresAt: Date.now() + 1000 }];
    m.ownerRefusal = null;
    m.ownerGrants = [];
    m.inbox.mockResolvedValue({ items: [{ id: 'i-1', state: 'held' }, { id: 'i-2', state: 'queued' }] });
    m.announcements.mockResolvedValue({ announcements: [] });
    m.fleet.mockResolvedValue({ at: 1, thresholds: { stallMinutes: 30, waitingLongMinutes: 120, unansweredMinutes: 30, composerMinutes: 2 }, rows: [], unattributed: [], errors: [] });
  });

  it('refuses a valid CLI token without a human session (401) and reads no store', async () => {
    // Pin the token in memory so the test never touches ~/.purplemux/cli-token.
    (globalThis as unknown as { __ptCliToken?: string }).__ptCliToken = 'c'.repeat(64);
    const { getCliToken, verifyTokenValue } = await import('@/lib/cli-token');
    expect(verifyTokenValue(getCliToken())).toBe(true);
    expect((await call({ 'x-pmux-token': getCliToken() })).status).toBe(401);
    expect(m.leases).not.toHaveBeenCalled();
    expect(m.notes).not.toHaveBeenCalled();
    expect(m.watches).not.toHaveBeenCalled();
    expect(m.inbox).not.toHaveBeenCalled();
    expect(m.fleet).not.toHaveBeenCalled();
    expect(m.announcements).not.toHaveBeenCalled();
  });

  it('serves the fleet view (ADR-0023) as its own section', async () => {
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.fleet).toEqual({ ok: true, view: expect.objectContaining({ rows: [], unattributed: [], errors: [] }) });
  });

  it('a failing fleet read shows its error and the other sections still render', async () => {
    m.fleet.mockRejectedValue(new Error('workspaces.json unreadable'));
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.fleet).toEqual({ ok: false, error: 'workspaces.json unreadable' });
    expect(r.body.leases.ok).toBe(true);
  });

  it('serves the deploy announcements of the last 24 h, newest first, with notice counts (ADR-0029 §9)', async () => {
    const now = Date.now();
    const by = { workspaceId: 'ws-ops', tabId: 'tab-d', admin: false };
    const recipient = (itemId: string) => ({ workspaceId: 'ws-a', tabId: 'tab-a', reasons: ['orchestrator'], itemId });
    m.announcements.mockResolvedValue({ announcements: [
      { id: 'd-older', reason: 'old', inMinutes: 5, createdAt: now - 25 * 3600_000, restartAt: now - 25 * 3600_000 + 300_000, by, recipients: [] },
      { id: 'd-past', reason: 'release 1', inMinutes: 5, createdAt: now - 3600_000, restartAt: now - 3300_000, by, recipients: [recipient('i-1'), recipient('i-gone')] },
      { id: 'd-next', reason: 'release 2', inMinutes: 10, createdAt: now - 60_000, restartAt: now + 540_000, by, recipients: [recipient('i-2')] },
    ] });
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.deploys).toEqual({ ok: true, items: [
      { id: 'd-next', reason: 'release 2', createdAt: now - 60_000, restartAt: now + 540_000, phase: 'pending', by,
        recipients: { total: 1, delivered: 0, queued: 1, held: 0, dropped: 0 } },
      { id: 'd-past', reason: 'release 1', createdAt: now - 3600_000, restartAt: now - 3300_000, phase: 'past', by,
        recipients: { total: 2, delivered: 0, queued: 0, held: 1, dropped: 0 } },
    ] });
  });

  it('an unreadable deploy store fails the deploys section alone', async () => {
    m.announcements.mockRejectedValue(new Error('deploy-announcements.json is malformed'));
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.deploys).toEqual({ ok: false, error: 'deploy-announcements.json is malformed' });
    expect(r.body.leases.ok).toBe(true);
    expect(r.body.inboxHeld.ok).toBe(true);
    expect(r.body.fleet.ok).toBe(true);
  });

  it('serves every section to a human: closed lease kept, open notes with age, active grants, held deliveries', async () => {
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.leases).toEqual({ ok: true, items: [{ name: 'merge:x/y', holderState: 'closed' }] });
    expect(r.body.notes.items).toEqual([expect.objectContaining({ id: 'n-1', ageSeconds: expect.any(Number) })]);
    expect(r.body.watches.items).toHaveLength(1);
    expect(r.body.grants.items).toEqual([expect.objectContaining({ id: 'g-1' })]);
    expect(r.body.inboxHeld.items).toEqual([{ id: 'i-1', state: 'held' }]);
    expect(r.body.host).toEqual({ available: false, reason: 'test host' });
    expect(r.body.signals).toEqual({ state: 'not-configured' });
    // The watch list is read for every workspace (admin view).
    expect(m.watches).toHaveBeenCalledWith(expect.objectContaining({ admin: true }), null);
  });

  it('a failing store shows its own error and the other sections still render', async () => {
    m.notes.mockRejectedValue(new Error('notes.json is malformed'));
    m.refusal = 'grants.json is malformed; no grant is honoured';
    m.ownerRefusal = 'owner-grants.json is malformed; no grant is honoured';
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.status).toBe(200);
    expect(r.body.notes).toEqual({ ok: false, error: 'notes.json is malformed' });
    // Both grant files refused: only then is the whole section an error.
    expect(r.body.grants).toEqual({
      ok: false, error: 'grants.json is malformed; no grant is honoured; owner-grants.json is malformed; no grant is honoured',
    });
    expect(r.body.leases.ok).toBe(true);
  });

  it('grants: an owner-only grant shows; one refused file names itself and the other file still lists (ADR-0029 §1)', async () => {
    const owner = { id: 'g-own1', capability: 'owner', workspaces: ['*'], revokedAt: null, expiresAt: Date.now() + 1000 };
    m.grants = [];
    m.ownerGrants = [owner];
    expect((await call({ cookie: 'session-token=good-session' })).body.grants).toEqual({ ok: true, items: [owner], refused: [] });

    m.grants = [{ id: 'g-1', revokedAt: null, expiresAt: Date.now() + 1000 }];
    m.refusal = 'grants.json is malformed; no grant is honoured';
    expect((await call({ cookie: 'session-token=good-session' })).body.grants).toEqual({
      ok: true,
      items: [owner],
      refused: [{ capability: 'drive', file: 'grants.json', error: 'grants.json is malformed; no grant is honoured', code: 'grant-store-unreadable' }],
    });

    m.refusal = null;
    m.ownerRefusal = 'owner-grants.json is malformed; no grant is honoured';
    const r = await call({ cookie: 'session-token=good-session' });
    expect(r.body.grants).toMatchObject({ ok: true, items: [expect.objectContaining({ id: 'g-1' })], refused: [{ capability: 'owner', file: 'owner-grants.json' }] });
  });
});
