import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { INotesDeps, NotesService } from '@/lib/notes-service';
import type { INotesState } from '@/types/note';
import type { IInboxItem } from '@/types/inbox';

const fixture = vi.hoisted(() => ({ home: '', service: null as NotesService | null }));
vi.mock('os', async (original) => {
  const actual = await original<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => fixture.home }, homedir: () => fixture.home };
});
vi.mock('@/lib/cli-token', () => ({ verifyTokenValue: (token: string) => token === 'global' }));
vi.mock('@/lib/layout-store', async (original) => ({ ...await original<typeof import('@/lib/layout-store')>(), readLayoutFile: vi.fn(async () => null) }));
vi.mock('@/lib/notes-service', async (original) => ({ ...await original<typeof import('@/lib/notes-service')>(), getNotesService: async () => fixture.service }));

const checks = createRequire(import.meta.url)(path.resolve('scripts/acceptance/checks.cjs'));
const roots = () => globalThis as Record<string, unknown>;
const reset = () => { for (const key of ['__ptTabTokens', '__ptTabTokenLock', '__ptWorkspaceTokens']) delete roots()[key]; };
const tokenFile = () => path.join(fixture.home, '.purplemux/tab-tokens.json');
const settled = async () => { await roots().__ptTabTokenLock; };
let state: INotesState;
let inbox: Map<string, IInboxItem>;
let roles: Map<string, string>;
let revisions: Map<string, number>;
let tabs: Map<string, { workspaceId: string; tabId: string; sessionName: string }>;
let fixtureAgents: Map<string, { workspaceId: string; sessionName: string; sessionId: string; pid: number; startTicks: number; active: boolean }>;
let closedTabs: Set<string>;
let epics: Map<string, { workspaceId: string; tabId: string }>;
let records: Record<string, unknown>;
let service: NotesService;
let inputFile: string;
let sequence: number;
let agentSequence: number;
const created = async (workspaceId: string, name: string, _type: string, _extra: string[] = []) => {
  const tabId = name.replace('acc2-', 'tab-');
  const tab = { workspaceId, tabId, sessionName: `session-${tabId}` };
  tabs.set(tabId, tab);
  records[tabId] = { token: `token-${tabId}`, workspaceId, sessionName: tab.sessionName, createdAt: '2026-10-06', origin: 'launch' };
  fs.writeFileSync(tokenFile(), JSON.stringify(records));
  return tab;
};
const request = async (tabId: string, args: string[]) => {
  const emitter = new EventEmitter();
  let body: unknown;
  const response = Object.assign(emitter, {
    statusCode: 200,
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { body = value; emitter.emit('finish'); return this; },
    setHeader() {},
  });
  const req = { method: 'POST', headers: { 'x-pmux-token': `token-${tabId}` }, query: {}, body: {} } as unknown as NextApiRequest;
  const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (args[0] === 'note') {
    if (args[1] === 'send') {
      req.body = { toWorkspace: value('--to-workspace'), toEpic: value('--to-epic'), subject: value('--subject'), body: fs.readFileSync(value('-f')!, 'utf8') };
      await (await import('@/pages/api/cli/notes')).default(req, response as unknown as NextApiResponse);
    } else {
      req.query = { id: args[2] };
      if (args[1] === 'ack') await (await import('@/pages/api/cli/notes/[id]/ack')).default(req, response as unknown as NextApiResponse);
      else {
        req.method = 'GET';
        await (await import('@/pages/api/cli/notes/[id]')).default(req, response as unknown as NextApiResponse);
      }
    }
  } else if (args[0] === 'tab') {
    req.query = { workspaceId: value('-w'), tabId: args[4] };
    req.body = { content: args[5] };
    const handler = args[1] === 'send' ? (await import('@/pages/api/cli/tabs/[tabId]/send')).default : (await import('@/pages/api/cli/tabs/[tabId]/steer')).default;
    await handler(req, response as unknown as NextApiResponse);
  } else throw new Error(`unexpected request ${args}`);
  await settled();
  return { rc: response.statusCode < 400 ? 0 : response.statusCode === 403 ? 3 : 1, out: JSON.stringify(body), err: '' };
};
beforeEach(async () => {
  vi.resetModules(); reset();
  fixture.home = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-combined-'));
  fs.mkdirSync(path.join(fixture.home, '.purplemux'));
  state = { notes: [] }; inbox = new Map(); roles = new Map(); revisions = new Map(); tabs = new Map(); fixtureAgents = new Map(); closedTabs = new Set();
  epics = new Map(); records = {}; sequence = 0; agentSequence = 0; inputFile = '';
  const deps: INotesDeps = {
    now: () => Date.now(), newId: () => `n-combined${++sequence}`,
    mutate: async (fn) => { const result = await fn(state); state = result.state; return result.value; },
    read: async () => state, epicHolder: async (slug) => epics.get(slug) ?? null,
    holdsEpic: async (caller, slug) => epics.get(slug)?.tabId === caller.tabId,
    orchestratorOf: async (ws) => roles.get(ws) ?? null,
    withMappingRead: async (_ws, work) => work(), workspaceExists: async () => true,
    liveTabs: async () => ({ tabs: [...tabs.values()], uncertainWorkspaceIds: new Set() }),
    enqueue: async (req) => {
      const item = { ...req, id: `i-combined${inbox.size}`, state: 'queued', createdAt: Date.now(), deliveredAt: null } as unknown as IInboxItem;
      inbox.set(item.id, item); return { item };
    },
    withdraw: async (id, reason) => {
      const item = inbox.get(id);
      if (!item || item.state === 'delivered') return false;
      inbox.set(id, { ...item, state: 'dropped', droppedReason: reason }); return true;
    },
    inboxItems: async () => [...inbox.values()],
  };
  service = new (await import('@/lib/notes-service')).NotesService(deps);
  fixture.service = service;
});
afterEach(async () => { await settled(); reset(); fs.rmSync(fixture.home, { recursive: true, force: true }); });

describe('combined routing, caller authentication and mutation confinement', () => {
  it('runs the actual acceptance note fixture through real note/send/steer routes and routing service', async () => {
    const ok = { rc: 0, out: '{}', err: '' };
    const mapping = (workspaceId: string) => ({
      enabled: roles.has(workspaceId),
      orchestratorTabId: roles.get(workspaceId) ?? null,
      revision: revisions.get(workspaceId) ?? 0,
    });
    const designate = async (workspaceId: string, tabId: string) => {
      const tab = tabs.get(tabId);
      if (!tab || tab.workspaceId !== workspaceId) return { rc: 1, out: '', err: 'tab not found in workspace' };
      roles.set(workspaceId, tabId);
      revisions.set(workspaceId, (revisions.get(workspaceId) ?? 0) + 1);
      return { ...ok, out: JSON.stringify({ orchestration: mapping(workspaceId) }) };
    };
    const startFixtureAgent = async (workspaceId: string, tab: { workspaceId: string; tabId: string; sessionName: string }, opts: { inputFile?: string } = {}) => {
      const actual = tabs.get(tab.tabId);
      if (!actual || actual.workspaceId !== workspaceId || actual.sessionName !== tab.sessionName) {
        return { rc: -1, out: '', err: 'fixture tab is absent or mismatched' };
      }
      if (opts.inputFile) inputFile = opts.inputFile;
      agentSequence += 1;
      fixtureAgents.set(tab.tabId, {
        workspaceId,
        sessionName: tab.sessionName,
        sessionId: `fixture-${tab.tabId}-${agentSequence}`,
        pid: 10000 + agentSequence,
        startTicks: 20000 + agentSequence,
        active: true,
      });
      return ok;
    };
    const inst = {
      state: { scratch: fixture.home },
      tabCli: (args: string[]) => JSON.stringify(args),
      inTab: async (_ws: string, tabId: string, command: string) => {
        const args: string[] = JSON.parse(command);
        if (args[0] === 'lease') {
          if (args[1] === 'acquire') epics.set(args[2].slice(5), tabs.get(tabId)!);
          else epics.delete(args[2].slice(5));
          return ok;
        }
        return request(tabId, args);
      },
      cli: async (args: string[]) => {
        if (args[0] === 'orchestration') {
          const ws = args[3];
          if (args[1] === 'on') return designate(ws, args[4]);
          if (args[1] === 'off') {
            roles.delete(ws);
            revisions.set(ws, (revisions.get(ws) ?? 0) + 1);
          }
          return { ...ok, out: JSON.stringify({ orchestration: mapping(ws) }) };
        }
        if (args[0] === 'tab' && args[1] === 'close') {
          const ws = args[3];
          const tabId = args[4];
          const tab = tabs.get(tabId);
          if (!tab || tab.workspaceId !== ws) return { rc: 4, out: '', err: 'target tab is absent' };
          tabs.delete(tabId);
          fixtureAgents.delete(tabId);
          closedTabs.add(tabId);
          return { rc: 0, out: 'ok\n', err: '' };
        }
        await service.tick();
        for (const item of inbox.values()) if (item.state === 'queued') {
          const permit = await service.preflight(item);
          if (permit.ok) {
            const note = state.notes.find((n) => n.inboxItemId === item.id)!;
            if (inputFile) fs.appendFileSync(inputFile, `[purplemux note ${note.id}]\n`);
            inbox.set(item.id, { ...item, state: 'delivered', deliveredAt: Date.now() });
            permit.settle();
          }
        }
        await service.tick();
        return { ...ok, out: JSON.stringify({ notes: state.notes }) };
      },
      designate,
      startFixtureAgent,
      restoreLiveFixtureAgent: startFixtureAgent,
      fixtureAgentState: async (workspaceId: string, tab: { workspaceId: string; tabId: string; sessionName: string }) => {
        const actual = tabs.get(tab.tabId);
        const agent = fixtureAgents.get(tab.tabId);
        const present = actual?.workspaceId === workspaceId && actual.sessionName === tab.sessionName;
        const identityMatches = agent?.workspaceId === workspaceId && agent.sessionName === tab.sessionName;
        const live = present && identityMatches && agent?.active === true;
        const status = present ? {
          alive: true,
          command: live ? 'claude' : 'bash',
          agentSessionId: live ? agent.sessionId : null,
        } : null;
        const result = present ? { rc: 0, out: JSON.stringify(status), err: '' } : { rc: 4, out: '', err: 'target tab is absent' };
        return {
          ok: live,
          result,
          status,
          facts: {
            tabPresent: present,
            identityMatches,
            active: agent?.active ?? false,
            sessionId: agent?.sessionId ?? null,
            pid: agent?.pid ?? null,
            startTicks: agent?.startTicks ?? null,
          },
        };
      },
      hook: async () => 204,
      cliState: async () => 'idle',
      keys: async (sessionName: string, keys: string) => {
        const tab = [...tabs.values()].find((candidate) => candidate.sessionName === sessionName);
        if (!tab) return { rc: 4, out: '', err: 'target tab is absent' };
        if (keys === 'C-c') {
          const agent = fixtureAgents.get(tab.tabId);
          if (agent) fixtureAgents.set(tab.tabId, { ...agent, active: false });
        }
        return ok;
      },
    };
    const outcomes: { id: string; passed: boolean; measured: string }[] = [];
    await checks.notes(inst, { nonce: 'combined', wsA: 'ws-a', wsB: 'ws-b', created,
      check: (id: string, _what: string, passed: boolean, measured: string) => outcomes.push({ id, passed, measured }),
    });
    expect(outcomes.map((r) => r.id)).toEqual(['note-source-authority', 'note-no-direct-drive', 'note-delivered', 'note-epic-coordinator', 'note-ack', 'note-stale-recipient', 'note-designated-housekeeping']);
    expect(outcomes.filter((r) => !r.passed)).toEqual([]);
    expect(state.notes).toHaveLength(2);
    expect(state.notes.every((n) => n.state === 'acked')).toBe(true);
    expect(Object.fromEntries(roles)).toEqual({ 'ws-a': 'tab-reader', 'ws-b': 'tab-sender' });
    expect(Object.fromEntries(revisions)).toEqual({ 'ws-a': 2, 'ws-b': 3 });
    expect([...tabs.keys()].sort()).toEqual(['tab-reader', 'tab-sender']);
    expect([...closedTabs].sort()).toEqual(['tab-orch-a', 'tab-worker']);
    expect([...fixtureAgents.entries()].map(([tabId, agent]) => ({ tabId, active: agent.active })).sort((a, b) => a.tabId.localeCompare(b.tabId)))
      .toEqual([{ tabId: 'tab-reader', active: true }, { tabId: 'tab-sender', active: true }]);
  }, 15000);

  it('routing denies a hook coordinator without presentation writes while preserving its local note authority', async () => {
    const worker = await created('ws-b', 'acc2-hook', 'terminal');
    records[worker.tabId] = { ...(records[worker.tabId] as object), origin: 'hook' };
    const original = JSON.stringify(records); fs.writeFileSync(tokenFile(), original);
    roles.set('ws-b', worker.tabId);
    const file = path.join(fixture.home, 'body.txt'); fs.writeFileSync(file, 'body');
    const result = await request(worker.tabId, ['note', 'send', '--to-workspace', 'ws-a', '--subject', 'hook denied', '-f', file]);
    expect(result.rc).toBe(3);
    expect(state.notes).toEqual([]); expect(inbox.size).toBe(0);
    expect(fs.readFileSync(tokenFile(), 'utf8')).toBe(original);
    expect((await import('@/lib/tab-token')).getTabTokenRecord(worker.tabId)?.presentedAt).toBeUndefined();
    const local = await request(worker.tabId, ['note', 'send', '--to-workspace', 'ws-b', '--subject', 'local accepted', '-f', file]);
    expect(local.rc).toBe(0);
    expect(state.notes).toHaveLength(1);
    expect((await import('@/lib/tab-token')).getTabTokenRecord(worker.tabId)?.presentedAt).toEqual(expect.any(String));
  });
});
