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
let tabs: Map<string, { workspaceId: string; tabId: string; sessionName: string }>;
let epics: Map<string, { workspaceId: string; tabId: string }>;
let records: Record<string, unknown>;
let service: NotesService;
let inputFile: string;
let sequence: number;
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
  state = { notes: [] }; inbox = new Map(); roles = new Map(); tabs = new Map(); epics = new Map(); records = {}; sequence = 0; inputFile = '';
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
          if (args[1] === 'on') roles.set(ws, args[4]);
          if (args[1] === 'off') roles.delete(ws);
          return { ...ok, out: JSON.stringify({ orchestration: { enabled: roles.has(ws), orchestratorTabId: roles.get(ws) ?? null } }) };
        }
        if (args[0] === 'tab') return ok;
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
      designate: async (ws: string, tabId: string) => { roles.set(ws, tabId); return ok; },
      startFixtureAgent: async (_ws: string, _tab: unknown, opts: { inputFile?: string } = {}) => { if (opts.inputFile) inputFile = opts.inputFile; return ok; },
      hook: async () => 204, cliState: async () => 'idle', keys: async () => ok,
    };
    const outcomes: { id: string; passed: boolean; measured: string }[] = [];
    await checks.notes(inst, { nonce: 'combined', wsA: 'ws-a', wsB: 'ws-b', created,
      check: (id: string, _what: string, passed: boolean, measured: string) => outcomes.push({ id, passed, measured }),
    });
    expect(outcomes.map((r) => r.id)).toEqual(['note-source-authority', 'note-no-direct-drive', 'note-delivered', 'note-epic-coordinator', 'note-ack', 'note-stale-recipient', 'note-designated-housekeeping']);
    expect(outcomes.filter((r) => !r.passed)).toEqual([]);
    expect(state.notes).toHaveLength(2);
    expect(state.notes.every((n) => n.state === 'acked')).toBe(true);
    expect(roles.size).toBe(2);
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
