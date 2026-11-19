import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ICaller } from '@/lib/caller';
import { lookupAddress, type IAddressLookupDeps } from '@/lib/address-lookup';
import { addressOf, clearAddress, registerAddress, resetMessagingDirectory } from '@/lib/messaging-directory';
import type { ITab, TPanelType } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

// ADR-0050 (S1, and the owner's ruling of 20 Nov 2026 on lead pairs): `tab address` answers a Claude seat's SendMessage
// address only where `tab send` from the same caller passes the drive guard, plus the one lead-pair arm.

const SOCK = (pid: number) => `/run/user/1000/cc-socks/${pid}.sock`;
const SEND_HINT = 'use `purplemux tab send`; it queues';
const NOTE_HINT = 'use `purplemux note send`; a note is the route between workspaces';

interface ITabSpec { panelType: TPanelType; host?: string; sessionName: string }

const caller = (workspaceId: string, tabId: string | null, verified = true): ICaller => ({
  scope: { type: 'workspace', workspaceId, ...(tabId ? { tabId, ...(verified ? { tabVerified: true } : {}) } : {}) } as ICaller['scope'],
  workspaceId, tabId, tabName: tabId, verified, identity: verified ? 'launch' : 'hook', admin: false,
});
const ADMIN: ICaller = { scope: { type: 'admin' }, workspaceId: null, tabId: null, tabName: null, verified: false, identity: 'none', admin: true };

const setup = () => {
  const world = {
    tabs: new Map<string, ITabSpec>([
      ['ws-A/tab-1', { panelType: 'claude-code', sessionName: 's-A-1' }],
      ['ws-A/tab-2', { panelType: 'claude-code', sessionName: 's-A-2' }],
      ['ws-A/tab-term', { panelType: 'terminal', sessionName: 's-A-t' }],
      ['ws-A/tab-codex', { panelType: 'codex-cli', sessionName: 's-A-c' }],
      ['ws-A/tab-remote', { panelType: 'claude-code', sessionName: 's-A-r', host: 'host-b' }],
      ['ws-B/tab-lead', { panelType: 'claude-code', sessionName: 's-B-l' }],
      ['ws-B/tab-worker', { panelType: 'claude-code', sessionName: 's-B-w' }],
      ['ws-A/tab-lead', { panelType: 'claude-code', sessionName: 's-A-l' }],
      ['ws-C/tab-x', { panelType: 'claude-code', sessionName: 's-C-x' }],
    ]),
    orchestrators: new Map<string, string>([['ws-A', 'tab-lead'], ['ws-B', 'tab-lead']]),
    scrumMaster: null as string | null,
    sessions: new Set(['s-A-1', 's-A-2', 's-A-t', 's-A-c', 's-A-r', 's-B-l', 's-B-w', 's-A-l', 's-C-x']),
    live: new Map<string, { agentSessionId: string | null; cliState: TCliState | null }>(),
    sockets: new Set<string>(),
    deadPids: new Set<number>(),
    addressOn: true,
    leadPairOn: true,
    connects: 0,
  };
  const audit = vi.fn(async (_entry: Record<string, unknown>) => true);
  const deps: IAddressLookupDeps = {
    addressOn: async () => world.addressOn,
    leadPairOn: async () => world.leadPairOn,
    findTab: async (ws, tab) => {
      const spec = world.tabs.get(`${ws}/${tab}`);
      return spec ? ({ id: tab, name: tab, order: 0, ...spec } as ITab) : null;
    },
    hasSession: async (name) => world.sessions.has(name),
    isWorkspaceOrchestrator: async (ws, tab) => world.orchestrators.get(ws) === tab,
    scrumMasterMayMutate: async (scope, ws) => scope.type === 'workspace' && world.scrumMaster === scope.workspaceId && ws !== scope.workspaceId,
    liveStatus: (tabId) => world.live.get(tabId) ?? null,
    socketExists: async (p) => world.sockets.has(p),
    pidAlive: (pid) => !world.deadPids.has(pid),
    audit,
  };
  const register = (ws: string, tab: string, pid: number, permissionMode: string | null = 'bypassPermissions', session: string | null = `sess-${tab}`) => {
    world.sockets.add(SOCK(pid));
    world.live.set(tab, { agentSessionId: session, cliState: 'busy' });
    return registerAddress({ tabId: tab, workspaceId: ws, socketPath: SOCK(pid), agentSessionId: session, host: world.tabs.get(`${ws}/${tab}`)?.host ?? null, permissionMode }, 1000);
  };
  const look = (c: ICaller | null, ws: string, tab: string) => lookupAddress(deps, c, { workspaceId: ws, tabId: tab });
  return { world, deps, audit, register, look };
};

describe('tab address (ADR-0050, S1)', () => {
  beforeEach(() => resetMessagingDirectory());

  it('address-same-workspace: 200 with a uds: address, the permission mode and the registration times', async () => {
    const { register, look } = setup();
    register('ws-A', 'tab-1', 101);
    register('ws-A', 'tab-2', 102);
    expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).toEqual({
      status: 200,
      body: { tabId: 'tab-2', workspaceId: 'ws-A', address: `uds:${SOCK(102)}`, permissionMode: 'bypassPermissions', registeredAt: 1000, lastSeenAt: 1000 },
    });
  });

  describe('address-refusals: each code, its HTTP status and its hint', () => {
    const refusal = (status: number, code: string, hint = SEND_HINT) => ({ status, body: expect.objectContaining({ code, hint }) });

    it('caller-unresolved: a caller with no tab, or one that is not a Claude tab', async () => {
      const { register, look } = setup();
      register('ws-A', 'tab-2', 102);
      expect(await look(caller('ws-A', null), 'ws-A', 'tab-2')).toEqual(refusal(409, 'caller-unresolved'));
      expect(await look(caller('ws-A', 'tab-term'), 'ws-A', 'tab-2')).toEqual(refusal(409, 'caller-unresolved'));
    });

    it('address-not-claude: the target is not a claude-code tab', async () => {
      const { look } = setup();
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-codex')).toEqual(refusal(409, 'address-not-claude'));
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-term')).toEqual(refusal(409, 'address-not-claude'));
    });

    it('address-unknown: no registration yet', async () => {
      const { look } = setup();
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).toEqual(refusal(409, 'address-unknown'));
    });

    it.each([
      ['the socket file is missing', (w: ReturnType<typeof setup>['world']) => { w.sockets.delete(SOCK(102)); }],
      ['the process is dead', (w: ReturnType<typeof setup>['world']) => { w.deadPids.add(102); }],
      ['the session id changed', (w: ReturnType<typeof setup>['world']) => { w.live.set('tab-2', { agentSessionId: 'sess-new', cliState: 'busy' }); }],
      ['the agent turned inactive', (w: ReturnType<typeof setup>['world']) => { w.live.set('tab-2', { agentSessionId: 'sess-tab-2', cliState: 'inactive' }); }],
    ])('address-stale when %s; the entry is cleared', async (_label, mutate) => {
      const { world, register, look } = setup();
      register('ws-A', 'tab-2', 102);
      mutate(world);
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).toEqual(refusal(409, 'address-stale'));
      expect(addressOf('ws-A', 'tab-2')).toBeNull();
    });

    it('address-other-host: the caller and the target run on different hosts', async () => {
      const { register, look } = setup();
      register('ws-A', 'tab-remote', 103);
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-remote')).toEqual(refusal(409, 'address-other-host'));
    });

    it('address-class-mismatch: a bypass target and a caller known to prompt; an unknown caller class is answered', async () => {
      const { register, look } = setup();
      register('ws-A', 'tab-2', 102, 'bypassPermissions');
      register('ws-A', 'tab-1', 101, 'default');
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).toEqual(refusal(409, 'address-class-mismatch'));
      clearAddress('ws-A', 'tab-1');
      expect((await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).status).toBe(200);
      register('ws-A', 'tab-1', 101, null);
      expect((await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).status).toBe(200);
    });

    it('a target of unknown class is answered with permissionMode unknown', async () => {
      const { register, look } = setup();
      register('ws-A', 'tab-2', 102, null);
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).toMatchObject({ status: 200, body: { permissionMode: 'unknown' } });
    });

    it('address-disabled: the switch is off', async () => {
      const { world, register, look } = setup();
      register('ws-A', 'tab-2', 102);
      world.addressOn = false;
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).toEqual(refusal(409, 'address-disabled'));
    });

    it('tab-not-found (404) and session-not-running (409); a stopped session clears the entry', async () => {
      const { world, register, look } = setup();
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-gone')).toEqual(refusal(404, 'tab-not-found'));
      register('ws-A', 'tab-2', 102);
      world.sessions.delete('s-A-2');
      expect(await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).toEqual(refusal(409, 'session-not-running'));
      expect(addressOf('ws-A', 'tab-2')).toBeNull();
    });

    it('forbidden: no token, or the admin token, gets the drive guard\'s own body', async () => {
      const { look } = setup();
      for (const c of [null, ADMIN]) {
        const answer = await look(c, 'ws-A', 'tab-2');
        expect(answer.status).toBe(403);
        expect(answer.body).toMatchObject({ code: 'forbidden' });
      }
    });
  });

  it('address-parity-with-tab-send: own workspace and the selected Scrum Master are admitted as the drive guard admits them; another workspace is refused. The lead-pair arm is the ONE place where the lookup admits more than tab send does.', async () => {
    const { world, register, look } = setup();
    register('ws-A', 'tab-2', 102);
    expect((await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).status).toBe(200);
    world.tabs.set('ws-C/tab-sm', { panelType: 'claude-code', sessionName: 's-C-sm' });
    world.sessions.add('s-C-sm');
    world.scrumMaster = 'ws-C';
    expect((await look(caller('ws-C', 'tab-sm'), 'ws-A', 'tab-2')).status).toBe(200);
    world.scrumMaster = null;
    expect(await look(caller('ws-C', 'tab-x'), 'ws-A', 'tab-2')).toEqual({ status: 403, body: expect.objectContaining({ code: 'address-not-lead-pair', hint: NOTE_HINT }) });
  });

  describe('the lead-pair arm (the owner\'s ruling of 20 Nov 2026)', () => {
    it('address-lead-pair-admitted: one workspace\'s orchestrator looks up another\'s: 200, audited with scope lead-pair', async () => {
      const { register, look, audit } = setup();
      register('ws-B', 'tab-lead', 201);
      expect((await look(caller('ws-A', 'tab-lead'), 'ws-B', 'tab-lead')).status).toBe(200);
      expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'address-lookup', outcome: 'admitted', scope: 'lead-pair' }));
    });

    it.each([
      ['the caller is not a lead', 'ws-A', 'tab-1', 'ws-B', 'tab-lead', true],
      ['the target is not a lead', 'ws-A', 'tab-lead', 'ws-B', 'tab-worker', true],
      ['the caller\'s workspace has no resolved orchestrator', 'ws-C', 'tab-x', 'ws-B', 'tab-lead', true],
      ['the target\'s workspace has no resolved orchestrator', 'ws-A', 'tab-lead', 'ws-C', 'tab-x', true],
      ['the caller is its lead by an unverified token', 'ws-A', 'tab-lead', 'ws-B', 'tab-lead', false],
    ])('address-cross-workspace-non-lead-refused: %s', async (_label, cws, ctab, tws, ttab, verified) => {
      const { register, look, audit } = setup();
      register(tws, ttab as string, 301);
      const answer = await look(caller(cws as string, ctab as string, verified as boolean), tws as string, ttab as string);
      expect(answer).toEqual({ status: 403, body: expect.objectContaining({ code: 'address-not-lead-pair', hint: NOTE_HINT }) });
      expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'address-lookup', outcome: 'address-not-lead-pair' }));
    });

    it('address-lead-pair-switch-off: tab-address.lead-pair off refuses the cross-workspace arm alone', async () => {
      const { world, register, look } = setup();
      register('ws-B', 'tab-lead', 201);
      register('ws-A', 'tab-2', 102);
      world.leadPairOn = false;
      expect(await look(caller('ws-A', 'tab-lead'), 'ws-B', 'tab-lead')).toEqual({ status: 409, body: expect.objectContaining({ code: 'address-disabled' }) });
      expect((await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2')).status).toBe(200);
    });

    it('address-lead-pair-class-and-host: a lead pair in different classes or on different hosts keeps the refusals of a workspace', async () => {
      const { world, register, look } = setup();
      register('ws-B', 'tab-lead', 201, 'bypassPermissions');
      register('ws-A', 'tab-lead', 202, 'default');
      expect((await look(caller('ws-A', 'tab-lead'), 'ws-B', 'tab-lead')).body).toMatchObject({ code: 'address-class-mismatch' });
      clearAddress('ws-A', 'tab-lead');
      register('ws-B', 'tab-lead', 201, 'bypassPermissions');
      world.tabs.set('ws-B/tab-lead', { panelType: 'claude-code', sessionName: 's-B-l', host: 'host-b' });
      expect((await look(caller('ws-A', 'tab-lead'), 'ws-B', 'tab-lead')).body).toMatchObject({ code: 'address-other-host' });
    });
  });

  it('address-lookup-audited: one audit line per lookup, admitted or refused, with no body field', async () => {
    const { register, look, audit } = setup();
    register('ws-A', 'tab-2', 102);
    await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-2');
    await look(caller('ws-A', 'tab-1'), 'ws-A', 'tab-gone');
    await look(caller('ws-C', 'tab-x'), 'ws-A', 'tab-2');
    expect(audit).toHaveBeenCalledTimes(3);
    expect(audit.mock.calls.map(([e]) => [e.outcome, e.scope])).toEqual([
      ['admitted', 'same-workspace'], ['tab-not-found', 'same-workspace'], ['address-not-lead-pair', null],
    ]);
    for (const [entry] of audit.mock.calls) {
      expect(entry).toMatchObject({ event: 'address-lookup', caller: expect.any(Object), target: expect.any(Object) });
      expect(Object.keys(entry)).not.toContain('body');
      expect(JSON.stringify(entry)).not.toContain('sock');
    }
  });

  it('address-stale-check-read-only: the check stats the file and signals the pid; it never connects to a socket', async () => {
    const { defaultAddressLookupDeps } = await import('@/lib/address-lookup');
    const deps = await defaultAddressLookupDeps();
    expect(await deps.socketExists('/nonexistent/dir/1.sock')).toBe(false);
    expect(deps.pidAlive(process.pid)).toBe(true);
    expect(deps.pidAlive(2 ** 22 + 12345)).toBe(false);
    const source = (await import('fs')).readFileSync('src/lib/address-lookup.ts', 'utf-8') + (await import('fs')).readFileSync('src/lib/messaging-directory.ts', 'utf-8');
    expect(source).not.toMatch(/from 'net'|require\('net'\)|createConnection|\.connect\(/);
  });
});

describe('the messaging directory (ADR-0050, A2-A3)', () => {
  beforeEach(() => resetMessagingDirectory());

  it('directory-replace-and-clear: a registration replaces the entry; a clear removes it; a fresh directory is empty', () => {
    const first = registerAddress({ tabId: 'tab-1', workspaceId: 'ws-A', socketPath: SOCK(1), agentSessionId: 's1', host: null, permissionMode: 'default' }, 10)!;
    expect(first).toMatchObject({ address: `uds:${SOCK(1)}`, registeredAt: 10, lastSeenAt: 10, permissionMode: 'default' });
    const seen = registerAddress({ tabId: 'tab-1', workspaceId: 'ws-A', socketPath: SOCK(1), agentSessionId: 's1', host: null, permissionMode: null }, 20)!;
    expect(seen).toMatchObject({ registeredAt: 10, lastSeenAt: 20, permissionMode: 'default' });
    const moved = registerAddress({ tabId: 'tab-1', workspaceId: 'ws-A', socketPath: SOCK(2), agentSessionId: 's2', host: null, permissionMode: 'bypassPermissions' }, 30)!;
    expect(moved).toMatchObject({ address: `uds:${SOCK(2)}`, registeredAt: 30, agentSessionId: 's2' });
    expect(clearAddress('ws-A', 'tab-1')).toBe(true);
    expect(addressOf('ws-A', 'tab-1')).toBeNull();
    registerAddress({ tabId: 'tab-1', workspaceId: 'ws-A', socketPath: SOCK(1), agentSessionId: 's1', host: null, permissionMode: null }, 40);
    resetMessagingDirectory();
    expect(addressOf('ws-A', 'tab-1')).toBeNull();
  });

  it('hook-route-socket-grammar (store half): a path off the grammar or a mode that is not a word stores nothing', () => {
    for (const socketPath of ['relative.sock', '/a b.sock', '/a"b.sock', `/${'a'.repeat(107)}.sock`, '/x.socket']) {
      expect(registerAddress({ tabId: 'tab-1', workspaceId: 'ws-A', socketPath, agentSessionId: null, host: null, permissionMode: null }, 1)).toBeNull();
    }
    expect(registerAddress({ tabId: 'tab-1', workspaceId: 'ws-A', socketPath: SOCK(1), agentSessionId: null, host: null, permissionMode: 'by pass' }, 1))
      .toMatchObject({ permissionMode: 'unknown' });
  });

  it('directory-replace-and-clear: a closed tab loses its entry through the tab-closed event', async () => {
    const { startMessagingDirectory } = await import('@/lib/messaging-directory');
    const { emitTabClosed } = await import('@/lib/tab-lifecycle');
    await startMessagingDirectory();
    registerAddress({ tabId: 'tab-1', workspaceId: 'ws-A', socketPath: SOCK(1), agentSessionId: null, host: null, permissionMode: null }, 1);
    emitTabClosed({ workspaceId: 'ws-A', tabId: 'tab-1' } as Parameters<typeof emitTabClosed>[0]);
    expect(addressOf('ws-A', 'tab-1')).toBeNull();
  });
});
