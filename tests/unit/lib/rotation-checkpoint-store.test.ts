import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { LedgerStore } from '@/lib/ledger-store';
import { CheckpointConflictError } from '@/lib/rotation-checkpoint-store';
import { buildCheckpoint, checkpointDigest } from '@/lib/rotation-checkpoint';
import type { IRotationCheckpoint } from '@/types/rotation-checkpoint';

// vel-D5 AC1, AC2: `rotation_checkpoints` in the ledger file: durable across a reopen, immutable once applied, and
// every step a conditional move, so a step that runs twice changes nothing.

const cp = (attempt: number, resume = '/v2-lane kit'): IRotationCheckpoint => buildCheckpoint({
  taskId: 'seat:ws-a:kit', attempt, workspaceId: 'ws-a', tabId: 'tab-kit', tabName: 'kit', host: null, createdAt: 1_000 + attempt,
  handoffPath: '/h/handoff.md', handoffText: `# Handoff: kit · updated 2026-11-08T10:00:00Z\n\n## Resume command\n${resume}\n`,
  facts: { kind: 'no-repo', cwd: '/h', worktree: null, branch: null, head: null, baseRef: null, base: null, dirty: null }, sessionBefore: 'sess-1',
});

describe('rotation_checkpoints', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a committed row survives a reopen of the ledger file (another process after a crash)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-cp-'));
    dirs.push(dir);
    const file = path.join(dir, 'ledger.sqlite');
    const first = new LedgerStore(file);
    first.checkpoints.put(cp(1), 5);
    first.close();
    const second = new LedgerStore(file);
    expect(second.checkpoints.get('ws-a', 'seat:ws-a:kit#1')).toMatchObject({ status: 'written', digest: checkpointDigest(cp(1)), checkpoint: cp(1) });
    second.close();
  });

  it('the same body again changes nothing; a row still written takes a new body; an applied row refuses one', () => {
    const store = new LedgerStore(':memory:');
    store.checkpoints.put(cp(1), 5);
    store.checkpoints.put(cp(1), 6);
    expect(store.checkpoints.get('ws-a', 'seat:ws-a:kit#1')?.updatedAt).toBe(5);
    store.checkpoints.put(cp(1, '/v2-lane kit --again'), 7);
    expect(store.checkpoints.get('ws-a', 'seat:ws-a:kit#1')).toMatchObject({ status: 'written', checkpoint: { intendedNextAction: '/v2-lane kit --again' } });
    expect(store.checkpoints.mark('ws-a', 'seat:ws-a:kit#1', ['written'], 'cleared', 8)).toBe(true);
    expect(() => store.checkpoints.put(cp(1), 9)).toThrow(CheckpointConflictError);
    expect(() => store.checkpoints.put(cp(1), 9)).toThrow(/already cleared with another body/);
    store.checkpoints.put(cp(1, '/v2-lane kit --again'), 10);
    expect(store.checkpoints.get('ws-a', 'seat:ws-a:kit#1')).toMatchObject({ status: 'cleared', updatedAt: 8 });
  });

  it('a step moves only from the states it names; a second run is a no-op', () => {
    const store = new LedgerStore(':memory:');
    store.checkpoints.put(cp(1), 5);
    expect(store.checkpoints.mark('ws-a', 'seat:ws-a:kit#1', ['cleared'], 'delivering', 6)).toBe(false);
    expect(store.checkpoints.mark('ws-a', 'seat:ws-a:kit#1', ['written', 'cleared'], 'delivering', 6)).toBe(true);
    expect(store.checkpoints.mark('ws-a', 'seat:ws-a:kit#1', ['written', 'cleared'], 'delivering', 7)).toBe(false);
    expect(store.checkpoints.mark('ws-a', 'seat:ws-a:kit#1', ['delivering'], 'delivered', 8)).toBe(true);
    expect(store.checkpoints.mark('ws-a', 'seat:ws-a:kit#1', ['delivering'], 'delivered', 9)).toBe(false);
    expect(store.checkpoints.get('ws-a', 'seat:ws-a:kit#1')).toMatchObject({ status: 'delivered', updatedAt: 8 });
    expect(store.checkpoints.mark('ws-a', 'seat:ws-a:nope#1', ['written'], 'cleared', 9)).toBe(false);
  });

  it('latest is the task\'s highest attempt, per workspace', () => {
    const store = new LedgerStore(':memory:');
    expect(store.checkpoints.latest('ws-a', 'seat:ws-a:kit')).toBeNull();
    store.checkpoints.put(cp(2), 5);
    store.checkpoints.put(cp(1), 6);
    expect(store.checkpoints.latest('ws-a', 'seat:ws-a:kit')?.checkpoint.attempt).toBe(2);
    expect(store.checkpoints.latest('ws-b', 'seat:ws-a:kit')).toBeNull();
  });
});
