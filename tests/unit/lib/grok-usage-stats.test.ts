import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseGrokContent } from '@/lib/session-parser-grok';

const mockHome = vi.hoisted(() => ({ value: '' }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures');

const importFresh = async () => {
  vi.resetModules();
  return {
    usage: await import('@/lib/stats/grok-usage'),
    home: await import('@/lib/grok-home'),
  };
};

const seedFromFixture = async (grokHome: string, fixture: string, cwd: string, sessionId: string) => {
  const dir = path.join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId);
  await fs.mkdir(dir, { recursive: true });
  for (const file of ['updates.jsonl', 'summary.json', 'signals.json']) {
    await fs.copyFile(path.join(FIXTURES, fixture, file), path.join(dir, file));
  }
  return dir;
};

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-grok-usage-'));
  await fs.mkdir(path.join(mockHome.value, '.grok'), { recursive: true });
});

const PLAIN = '01a008c1-bb96-71d1-9769-b63ff478fd9f';
const TOOLS = '01a008c3-8e98-7220-a0d3-e0b36fa3aa99';

describe('readGrokTurnTotals', () => {
  it('sums the turn_completed usage the recorded session carries', async () => {
    const { usage } = await importFresh();
    const content = await fs.readFile(path.join(FIXTURES, 'grok-session', 'updates.jsonl'), 'utf-8');

    expect(usage.readGrokTurnTotals(content)).toMatchObject({
      inputTokens: 19427,
      outputTokens: 39,
      cacheReadTokens: 128,
      cacheCreationTokens: 0,
      costTicks: 66123200,
      model: 'grok-4.6-build',
    });
  });

  it('counts one user message per streamed run, not one per chunk', async () => {
    const { usage } = await importFresh();
    const content = await fs.readFile(path.join(FIXTURES, 'grok-session-tools', 'updates.jsonl'), 'utf-8');

    expect(usage.readGrokTurnTotals(content).userMessageTimestamps).toHaveLength(1);
  });

  const chunk = (kind: string, text: string, atMs: number) => JSON.stringify({
    timestamp: Math.floor(atMs / 1000),
    method: 'session/update',
    params: {
      sessionId: PLAIN,
      update: { sessionUpdate: kind, content: { type: 'text', text } },
      _meta: { agentTimestampMs: atMs },
    },
  });

  const userMessageCount = (content: string) =>
    parseGrokContent(content, PLAIN).filter((entry) => entry.type === 'user-message').length;

  it('counts a slow multi-chunk prompt as the one message the transcript shows', async () => {
    const { usage } = await importFresh();
    const content = [
      chunk('user_message_chunk', 'write the ', 1786853300000),
      chunk('user_message_chunk', 'migration', 1786853305000),
    ].join('\n');

    expect(usage.readGrokTurnTotals(content).userMessageTimestamps).toHaveLength(userMessageCount(content));
    expect(usage.readGrokTurnTotals(content).userMessageTimestamps).toHaveLength(1);
  });

  it('counts two prompts under a second apart as the two messages the transcript shows', async () => {
    const { usage } = await importFresh();
    const content = [
      chunk('user_message_chunk', 'first', 1786853300000),
      chunk('agent_message_chunk', 'on it', 1786853300100),
      chunk('user_message_chunk', 'second', 1786853300200),
    ].join('\n');

    expect(usage.readGrokTurnTotals(content).userMessageTimestamps).toHaveLength(userMessageCount(content));
    expect(usage.readGrokTurnTotals(content).userMessageTimestamps).toEqual([1786853300000, 1786853300200]);
  });

  it('does not count a run that carries no text', async () => {
    const { usage } = await importFresh();
    const content = chunk('user_message_chunk', '   ', 1786853300000);

    expect(usage.readGrokTurnTotals(content).userMessageTimestamps).toHaveLength(userMessageCount(content));
  });
});

describe('readGrokUsage', () => {
  it('reports real cost — grok Build bills a subscription but still records spend', async () => {
    const { usage } = await importFresh();
    await seedFromFixture(path.join(mockHome.value, '.grok'), 'grok-session', '/repo', PLAIN);

    const summary = await usage.readGrokUsage('all');

    expect(summary.sessions).toHaveLength(1);
    expect(summary.sessions[0]).toMatchObject({
      sessionId: PLAIN,
      model: 'grok-4.6-build',
      inputTokens: 19427,
      outputTokens: 39,
      cacheReadTokens: 128,
      messageCount: 1,
    });
    expect(summary.sessions[0].cost).toBeCloseTo(0.00661232, 8);
  });

  it('walks every grok home, so a workspace tab is counted exactly once', async () => {
    const { usage, home } = await importFresh();
    await seedFromFixture(path.join(mockHome.value, '.grok'), 'grok-session', '/repo', PLAIN);
    const wsHome = await home.ensureWorkspaceGrokHome('ws-usage');
    await seedFromFixture(wsHome, 'grok-session-tools', '/repo', TOOLS);

    const summary = await usage.readGrokUsage('all');

    expect(summary.sessions.map((session) => session.sessionId).sort()).toEqual([PLAIN, TOOLS].sort());
    expect(summary.messageTimestamps).toHaveLength(2);
  });

  it('returns nothing when no grok session has been recorded', async () => {
    const { usage } = await importFresh();
    expect(await usage.readGrokUsage('all')).toEqual({ sessions: [], messageTimestamps: [] });
  });

  it('drops a session whose creation date falls outside the requested period', async () => {
    const { usage } = await importFresh();
    const dir = await seedFromFixture(path.join(mockHome.value, '.grok'), 'grok-session', '/repo', PLAIN);
    const summary = JSON.parse(await fs.readFile(path.join(dir, 'summary.json'), 'utf-8'));
    summary.created_at = '2020-01-01T00:00:00Z';
    await fs.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary));

    expect((await usage.readGrokUsage('today')).sessions).toEqual([]);
    expect((await usage.readGrokUsage('all')).sessions).toHaveLength(1);
  });
});
