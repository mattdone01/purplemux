import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

interface ITab {
  tabId: string;
  workspaceId: string;
  name: string;
  panelType?: string;
  cliState?: string | null;
  lastEvent?: { name: string } | null;
  busySince?: number | null;
}

interface IMidTurn { workspaceId: string; tabId: string; name: string; busyForS: number | null; reason: string }

interface IHelpers {
  listShape: (tabs: ITab[]) => 'new' | 'old';
  agentTabs: (tabs: ITab[]) => ITab[];
  midTurnTabs: (input: {
    tabs: ITab[];
    statuses: Record<string, Record<string, unknown>>;
    ownTabId: string | null;
    ignore: string[];
    now: number;
  }) => IMidTurn[];
  pickWorkspaceToken: (tabs: ITab[], tokens: Record<string, string>) => { workspaceId: string; token: string } | null;
  backupSqlite: (src: string, dst: string, modulePath: string) => Promise<void>;
}

const requireFromTest = createRequire(import.meta.url);
const helpers = requireFromTest('../../../scripts/deploy-live-helpers.cjs') as IHelpers;

const agent = (tabId: string, extra: Partial<ITab> = {}): ITab => ({
  tabId,
  workspaceId: 'ws-a',
  name: tabId,
  panelType: 'claude-code',
  ...extra,
});

describe('deploy-live helpers: list shape', () => {
  it('reads a list whose tabs carry the cliState key as the new shape', () => {
    expect(helpers.listShape([agent('tab-1', { cliState: null })])).toBe('new');
  });

  it('reads the b428f4d1 list (no cliState key) as the old shape', () => {
    expect(helpers.listShape([agent('tab-1')])).toBe('old');
  });

  it('keeps only agent panel types', () => {
    const tabs = [agent('tab-1'), agent('tab-2', { panelType: 'terminal' }), agent('tab-3', { panelType: 'codex-cli' })];
    expect(helpers.agentTabs(tabs).map((t) => t.tabId)).toEqual(['tab-1', 'tab-3']);
  });
});

describe('deploy-live helpers: mid-turn classification', () => {
  const base = { statuses: {}, ownTabId: null, ignore: [] as string[], now: 100_000 };

  it('counts a busy tab whose last event is not stop, with its busy time', () => {
    const tabs = [agent('tab-1', { cliState: 'busy', lastEvent: { name: 'prompt-submit' }, busySince: 40_000 })];
    expect(helpers.midTurnTabs({ ...base, tabs })).toEqual([
      { workspaceId: 'ws-a', tabId: 'tab-1', name: 'tab-1', busyForS: 60, reason: 'busy' },
    ]);
  });

  it('counts a busy tab with no last event (a restart lost it)', () => {
    const tabs = [agent('tab-1', { cliState: 'busy', lastEvent: null })];
    expect(helpers.midTurnTabs({ ...base, tabs }).map((t) => t.tabId)).toEqual(['tab-1']);
  });

  it('does not count a busy tab whose last event is stop (open background task)', () => {
    const tabs = [agent('tab-1', { cliState: 'busy', lastEvent: { name: 'stop' } })];
    expect(helpers.midTurnTabs({ ...base, tabs })).toEqual([]);
  });

  it('does not count idle, terminal or ready tabs', () => {
    const tabs = [
      agent('tab-1', { cliState: 'idle', lastEvent: null }),
      agent('tab-2', { cliState: 'ready-for-review', lastEvent: { name: 'stop' } }),
      agent('tab-3', { panelType: 'terminal', cliState: 'busy', lastEvent: null }),
    ];
    expect(helpers.midTurnTabs({ ...base, tabs })).toEqual([]);
  });

  it('excludes the own tab and every --ignore-tab ws/tab', () => {
    const busy = { cliState: 'busy', lastEvent: { name: 'prompt-submit' } };
    const tabs = [agent('tab-own', busy), agent('tab-x', busy), agent('tab-y', { ...busy, workspaceId: 'ws-b' })];
    const result = helpers.midTurnTabs({ ...base, tabs, ownTabId: 'tab-own', ignore: ['ws-b/tab-y'] });
    expect(result.map((t) => t.tabId)).toEqual(['tab-x']);
  });

  it('an --ignore-tab entry matches workspace and tab together', () => {
    const tabs = [agent('tab-x', { cliState: 'busy', lastEvent: null })];
    expect(helpers.midTurnTabs({ ...base, tabs, ignore: ['ws-other/tab-x'] }).map((t) => t.tabId)).toEqual(['tab-x']);
  });

  it('old shape: reads the per-tab status and counts every busy as mid-turn', () => {
    const tabs = [agent('tab-1'), agent('tab-2'), agent('tab-3')];
    const statuses = {
      'tab-1': { cliState: 'busy' },
      'tab-2': { cliState: 'idle' },
      'tab-3': { cliState: 'busy' },
    };
    const result = helpers.midTurnTabs({ ...base, tabs, statuses, ownTabId: 'tab-3' });
    expect(result).toEqual([{ workspaceId: 'ws-a', tabId: 'tab-1', name: 'tab-1', busyForS: null, reason: 'busy' }]);
  });

  it('old shape: a tab gone since the list is not mid-turn; an unreadable status is', () => {
    const tabs = [agent('tab-1'), agent('tab-2'), agent('tab-3')];
    const statuses = { 'tab-1': { gone: true }, 'tab-2': { error: 'HTTP 500' } };
    const result = helpers.midTurnTabs({ ...base, tabs, statuses });
    expect(result.map((t) => [t.tabId, t.reason])).toEqual([
      ['tab-2', 'status unreadable: HTTP 500'],
      ['tab-3', 'status unreadable: missing'],
    ]);
  });
});

describe('deploy-live helpers: workspace token for the health check', () => {
  it('prefers a workspace that has tabs', () => {
    const tabs = [agent('tab-1', { workspaceId: 'ws-b' })];
    expect(helpers.pickWorkspaceToken(tabs, { 'ws-a': 'ta', 'ws-b': 'tb' })).toEqual({ workspaceId: 'ws-b', token: 'tb' });
  });

  it('falls back to the first token, and to null when there is none', () => {
    expect(helpers.pickWorkspaceToken([], { 'ws-a': 'ta' })).toEqual({ workspaceId: 'ws-a', token: 'ta' });
    expect(helpers.pickWorkspaceToken([], {})).toBeNull();
  });
});

describe('deploy-live helpers: SQLite backup', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('copies rows that still sit in the WAL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-live-bk-'));
    dirs.push(dir);
    const src = path.join(dir, 'live.sqlite');
    const live = new Database(src);
    live.pragma('journal_mode = WAL');
    live.pragma('wal_autocheckpoint = 0');
    live.exec('CREATE TABLE t (v INTEGER)');
    const insert = live.prepare('INSERT INTO t (v) VALUES (?)');
    for (let i = 0; i < 50; i += 1) insert.run(i);
    expect(fs.statSync(`${src}-wal`).size).toBeGreaterThan(0);

    const dst = path.join(dir, 'backup.sqlite');
    await helpers.backupSqlite(src, dst, requireFromTest.resolve('better-sqlite3'));

    const copy = new Database(dst, { readonly: true });
    expect(copy.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 50 });
    copy.close();
    live.close();
  });
});
