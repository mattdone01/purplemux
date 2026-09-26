import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { readClaudeRuntimeSnapshot } from '@/lib/providers/claude/runtime-snapshot';
import { readCodexRuntimeSnapshot } from '@/lib/providers/codex/runtime-snapshot';
import { summarizeGrokEntries } from '@/lib/providers/grok/runtime-snapshot';

const FIXTURES = path.join(__dirname, '../../fixtures/turn-errors');
const fixture = (name: string) => path.join(FIXTURES, name);

const copyWith = async (name: string, extra: unknown[]): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-turn-error-'));
  const file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, (await fs.readFile(fixture(name), 'utf-8')) + extra.map((e) => JSON.stringify(e) + '\n').join(''));
  return file;
};

describe('lastTurnError — Claude Code 2.1.283 (structured fields only)', () => {
  it('classifies the recorded server_error stop (W4, 2026-09-26 01:30Z) as api-error', async () => {
    const snapshot = await readClaudeRuntimeSnapshot(fixture('claude-server-error-2.1.283.jsonl'), { force: true });
    expect(snapshot.lastTurnError).toEqual({
      class: 'api-error',
      code: 'server_error',
      text: expect.stringMatching(/^API Error: Server error mid-response/),
      turnId: 'cbb7ecd3-be79-4c44-ac45-0fa53331e1c0',
    });
  });

  it('classifies authentication_failed as other: never resumed', async () => {
    const snapshot = await readClaudeRuntimeSnapshot(fixture('claude-authentication-failed.jsonl'), { force: true });
    expect(snapshot.lastTurnError).toMatchObject({ class: 'other', code: 'authentication_failed' });
  });

  it('never reads the usage WARNING footer as an error, as a captured pane or as a quote', async () => {
    const snapshot = await readClaudeRuntimeSnapshot(fixture('claude-usage-warning-footer-negative.jsonl'), { force: true });
    expect(snapshot.lastTurnError).toBeNull();
    expect(snapshot.lastAssistantTail).toContain("You've used 92% of your session limit");
  });

  it('never reads a worker message that starts "API Error:" as an error', async () => {
    const file = await copyWith('claude-usage-warning-footer-negative.jsonl', [
      { type: 'assistant', timestamp: '2026-09-26T06:00:00.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'API Error: Server error mid-response — quoting W4' }] }, uuid: 'a-9' },
    ]);
    expect((await readClaudeRuntimeSnapshot(file, { force: true })).lastTurnError).toBeNull();
  });

  it('has no turn error once a clean answer or a new prompt follows the error', async () => {
    const clean = await copyWith('claude-server-error-2.1.283.jsonl', [
      { type: 'user', timestamp: '2026-09-26T01:31:00.000Z', message: { content: '[purplemux resume r-abcd12] the last turn ended on an API error — continue from where it was cut off' } },
    ]);
    expect((await readClaudeRuntimeSnapshot(clean, { force: true })).lastTurnError).toBeNull();
    const answered = await copyWith('claude-server-error-2.1.283.jsonl', [
      { type: 'assistant', timestamp: '2026-09-26T01:32:00.000Z', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'DONE: resumed' }] }, uuid: 'a-10' },
    ]);
    expect((await readClaudeRuntimeSnapshot(answered, { force: true })).lastTurnError).toBeNull();
  });
});

describe('lastTurnError — Codex task_complete.error', () => {
  it.each([
    ['codex-usage-limit-exceeded.jsonl', 'usage-limit', 'usage_limit_exceeded', /You've hit your usage limit/],
    ['codex-server-overloaded.jsonl', 'api-error', 'server_overloaded', /at capacity/],
    ['codex-other-401.jsonl', 'other', 'other', /401 Unauthorized/],
  ])('classifies %s as %s', async (name, cls, code, text) => {
    const snapshot = await readCodexRuntimeSnapshot(fixture(name), { force: true });
    expect(snapshot.lastTurnError).toMatchObject({ class: cls, code, text: expect.stringMatching(text) });
    expect(snapshot.lastTurnError?.turnId).toEqual(expect.any(String));
  });

  it('has no turn error for a clean task_complete or once a new prompt starts', async () => {
    const next = await copyWith('codex-server-overloaded.jsonl', [
      { timestamp: '2026-09-16T09:20:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'retry' } },
    ]);
    expect((await readCodexRuntimeSnapshot(next, { force: true })).lastTurnError ?? null).toBeNull();
    const clean = await copyWith('codex-server-overloaded.jsonl', [
      { timestamp: '2026-09-16T09:20:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'retry' } },
      { timestamp: '2026-09-16T09:21:00.000Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 't2', last_agent_message: 'DONE: ok' } },
    ]);
    expect((await readCodexRuntimeSnapshot(clean, { force: true })).lastTurnError).toBeNull();
  });
});

describe('lastTurnError — Grok (named gap)', () => {
  it('reports nothing: no Grok error shape has been recorded on this host', () => {
    const snapshot = summarizeGrokEntries([{ seq: 0, id: 'x', type: 'assistant-message', timestamp: 1, markdown: 'API Error: anything' }] as never, 2);
    expect(snapshot.lastTurnError).toBeUndefined();
  });
});
