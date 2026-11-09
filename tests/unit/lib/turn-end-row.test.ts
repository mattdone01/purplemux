import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { LedgerStore } from '@/lib/ledger-store';
import { StopGate, type IStopGateDeps, type IStopGateTab } from '@/lib/stop-gate';
import {
  MAX_BLOCKS_PER_TURN,
  cleanReason,
  decideStop,
  escalates,
  notBlockable,
  seatRoleOf,
  synthesizeLine,
  tailMarker,
  type IBlockability,
  type IStopDecisionInput,
  type ITurnEndRow,
} from '@/lib/turn-end-row';

// F6, folding in F10 steps 1 and 2 (design check (2) ruling, APPROVE-WITH-CHANGES, 2026-11-10).

const T0 = Date.UTC(2026, 10, 10, 1, 0, 0);
const S = 'sess-1';

const row = (over: Partial<ITurnEndRow> = {}): ITurnEndRow => ({
  sessionId: S, turnId: 1, workspaceId: 'ws-1', tabId: 'tab-w', seatRole: 'builder', story: 'F6', attempt: 1, verdict: 'DONE',
  head: 'a'.repeat(40), gateLog: '/w/g.log', gateVerdict: 'VALID', reason: 'shipped', source: 'done', unreportedReason: null,
  at: T0, consumedAt: null, ...over,
});

const worker: IBlockability = {
  stopFailure: false, replayed: false, remote: false, evaluator: false, provider: 'claude', openRotation: false, coordinator: false, scoped: true,
};

const input = (over: Partial<IStopDecisionInput> = {}): IStopDecisionInput => ({
  classifierOnly: false, blockability: worker, sessionId: S, row: null, tailMarker: 'DONE', openWork: async () => 0, blocks: 0, ...over,
});

describe('cleanReason (ruling (5))', () => {
  it('makes one line of the reason and keeps text', () => {
    expect(cleanReason('gate red\non lane 3 \tsee log')).toEqual({ ok: true, reason: 'gate red on lane 3 see log' });
    expect(cleanReason(undefined)).toEqual({ ok: true, reason: null });
    expect(cleanReason('  \n ')).toEqual({ ok: true, reason: null });
  });

  it.each(['see DONE: above', 'BLOCKED:x', 'it is (NEEDS-DECISION: which)', 'READY-TO-MERGE: #1'])('refuses a reason holding a marker word: %j', (text) => {
    expect(cleanReason(text)).toMatchObject({ ok: false, error: expect.stringContaining('holds the turn marker') });
  });

  it('keeps a marker-like word that is not a marker, and refuses a reason over 500 characters', () => {
    expect(cleanReason('UNDONE: nothing; X-DONE: no')).toMatchObject({ ok: true });
    expect(cleanReason('x'.repeat(501))).toMatchObject({ ok: false, error: expect.stringContaining('at most 500') });
    expect(cleanReason(42)).toMatchObject({ ok: false });
  });
});

describe('the seat, the synthesized line, the escalation', () => {
  it('reads a declared seat, else builder when the scope names a story, else none (ruling (8))', () => {
    expect(seatRoleOf({ story: 'F6' })).toBe('builder');
    expect(seatRoleOf({ story: 'F6', seat: 'reviewer' })).toBe('reviewer');
    expect(seatRoleOf({ story: null })).toBeNull();
    expect(seatRoleOf(null)).toBeNull();
  });

  it('starts with the marker and carries story, head and gate (ruling (5))', () => {
    expect(synthesizeLine(row())).toBe(`DONE: shipped (story F6, head ${'a'.repeat(12)}, gate VALID)`);
    expect(synthesizeLine(row({ verdict: 'BLOCKED', reason: 'gate red', head: null, gateVerdict: null }))).toBe('BLOCKED: gate red (story F6)');
    expect(synthesizeLine(row({ reason: null, story: null, head: null, gateVerdict: null }))).toBe('DONE: done');
    expect(tailMarker(synthesizeLine(row({ verdict: 'NEEDS-DECISION', reason: 'A or B' })))).toBe('NEEDS-DECISION');
  });

  it('a BLOCKED or NEEDS-DECISION tail escalates beyond DONE, READY-TO-MERGE and CHECKPOINTED rows only', () => {
    expect(escalates('DONE', 'BLOCKED')).toBe(true);
    expect(escalates('CHECKPOINTED', 'NEEDS-DECISION')).toBe(true);
    expect(escalates('BLOCKED', 'NEEDS-DECISION')).toBe(true);
    expect(escalates('NEEDS-DECISION', 'BLOCKED')).toBe(false);
    expect(escalates('DONE', 'DONE')).toBe(false);
    expect(escalates('BLOCKED', null)).toBe(false);
  });

  it.each([
    [{ stopFailure: true }, 'stop-failure'], [{ replayed: true }, 'replayed'], [{ remote: true }, 'remote'],
    [{ evaluator: true }, 'evaluator'], [{ provider: 'codex' }, 'provider-codex'], [{ openRotation: true }, 'rotation'],
    [{ coordinator: true }, 'coordinator'], [{ scoped: false }, 'unscoped'], [{}, null],
  ] as const)('never blocks %j: %s (ruling (4))', (over, why) => {
    expect(notBlockable({ ...worker, ...over })).toBe(why);
  });
});

describe('decideStop', () => {
  it('applies an unconsumed row that agrees with the tail', async () => {
    expect(await decideStop(input({ row: row() }))).toEqual({ kind: 'row', row: row() });
  });

  it('adversarial 1: a markerless stop with a live job is WAITING: no block, no row needed', async () => {
    const openWork = vi.fn(async () => 1);
    expect(await decideStop(input({ tailMarker: null, openWork }))).toEqual({ kind: 'classifier', why: 'waiting on open work' });
    expect(openWork).toHaveBeenCalledOnce();
  });

  it('blocks nothing when the open work is unknown by the deadline', async () => {
    expect(await decideStop(input({ tailMarker: null, openWork: async () => null }))).toMatchObject({ kind: 'classifier' });
  });

  it('reads no open work when the tail ends on a marker', async () => {
    const openWork = vi.fn(async () => 3);
    expect(await decideStop(input({ openWork }))).toMatchObject({ kind: 'block' });
    expect(openWork).not.toHaveBeenCalled();
  });

  it('blocks a turn end with no row twice, then lets it through as UNREPORTED cap (F10 AC2)', async () => {
    expect(await decideStop(input({ blocks: 0 }))).toMatchObject({ kind: 'block', reason: expect.stringContaining('stop 1 of 2 held') });
    expect(await decideStop(input({ blocks: 1 }))).toMatchObject({ kind: 'block', reason: expect.stringContaining('stop 2 of 2 held') });
    expect(await decideStop(input({ blocks: MAX_BLOCKS_PER_TURN }))).toEqual({ kind: 'unreported', reason: 'cap', escalation: null });
    expect((await decideStop(input())) as { reason: string }).toMatchObject({ reason: expect.stringContaining('purplemux done --verdict') });
  });

  it('ruling (6): a DONE row under a NEEDS-DECISION tail is held, then the escalating verdict applies at the cap', async () => {
    const mismatch = input({ row: row(), tailMarker: 'NEEDS-DECISION' });
    expect(await decideStop(mismatch)).toMatchObject({ kind: 'block', reason: expect.stringContaining('says DONE, but your last line ends NEEDS-DECISION') });
    expect(await decideStop({ ...mismatch, blocks: 2 })).toEqual({ kind: 'unreported', reason: 'cap', escalation: 'NEEDS-DECISION' });
  });

  it('gives a never-blockable scoped turn end an UNREPORTED row with its reason; unscoped and coordinator tabs keep the classifier', async () => {
    expect(await decideStop(input({ blockability: { ...worker, replayed: true } }))).toEqual({ kind: 'unreported', reason: 'not-blockable:replayed', escalation: null });
    expect(await decideStop(input({ blockability: { ...worker, evaluator: true } }))).toMatchObject({ reason: 'not-blockable:evaluator' });
    expect(await decideStop(input({ blockability: { ...worker, scoped: false } }))).toMatchObject({ kind: 'classifier', why: 'unscoped' });
    expect(await decideStop(input({ blockability: { ...worker, coordinator: true } }))).toMatchObject({ kind: 'classifier', why: 'coordinator' });
    // A replayed stop still takes its own row.
    expect(await decideStop(input({ blockability: { ...worker, replayed: true }, row: row() }))).toMatchObject({ kind: 'row' });
  });

  it('the kill switch and an unbound session leave the classifier', async () => {
    expect(await decideStop(input({ classifierOnly: true }))).toMatchObject({ kind: 'classifier', why: 'turn-end.source=classifier' });
    expect(await decideStop(input({ sessionId: null }))).toMatchObject({ kind: 'classifier' });
  });
});

describe('TurnEndsTable', () => {
  it('counts turns per session, replaces an unconsumed row, and lets one stop consume it', () => {
    const store = new LedgerStore(':memory:');
    const t = store.turnEnds;
    expect(t.currentTurn(S)).toBeNull();
    expect(t.bumpTurn(S, T0)).toBe(1);
    expect(t.addBlock(S, T0)).toBe(1);
    expect(t.bumpTurn(S, T0)).toBe(2);
    expect(t.currentTurn(S)).toEqual({ turnId: 2, blocks: 0 });
    expect(t.put(row({ turnId: 2 }))).toBe(true);
    expect(t.put(row({ turnId: 2, verdict: 'BLOCKED', reason: 'second' }))).toBe(true);
    expect(t.unconsumed(S, 2)).toMatchObject({ verdict: 'BLOCKED', reason: 'second' });
    expect(t.consume(S, 2, T0 + 1)).toBe(true);
    expect(t.consume(S, 2, T0 + 2)).toBe(false);
    expect(t.unconsumed(S, 2)).toBeNull();
    expect(t.put(row({ turnId: 2 }))).toBe(false);
    expect(t.list('ws-1', 0)).toHaveLength(1);
    store.close();
  });

  it('adversarial 3: the counter survives a restart; a new turn after it has no row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-turn-ends-'));
    try {
      const file = path.join(dir, 'ledger.sqlite');
      const before = new LedgerStore(file);
      before.turnEnds.bumpTurn(S, T0);
      before.turnEnds.put(row({ turnId: 1 }));
      before.close();
      const after = new LedgerStore(file);
      expect(after.turnEnds.unconsumed(S, 1)).toMatchObject({ verdict: 'DONE' });
      expect(after.turnEnds.bumpTurn(S, T0 + 1)).toBe(2);
      expect(after.turnEnds.unconsumed(S, 2)).toBeNull();
      after.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('StopGate', () => {
  const tab: IStopGateTab = { workspaceId: 'ws-1', agentSessionId: S, host: null, providerId: 'claude' };
  const make = (over: Partial<IStopGateDeps> = {}) => {
    const store = new LedgerStore(':memory:');
    let now = T0;
    const gate = new StopGate({
      now: () => now, table: () => store.turnEnds, rowsAreSource: () => true, payloadIsTail: () => true,
      isCoordinator: async () => false, isScoped: async () => true, roleOf: async () => null, inRotation: () => false,
      openWork: async () => 0, ...over,
    });
    store.turnEnds.bumpTurn(S, T0);
    return { gate, store, at: (ms: number) => { now = ms; } };
  };
  const payload = (message: string | null, sessionId: string | null = S) => ({ hookEvent: 'Stop', sessionId, message });

  it('holds a turn end with no row, counts it, and keeps no decision or tail for it', async () => {
    const { gate, store } = make();
    expect(await gate.decide('tab-w', tab, payload('Gate green.\n\nDONE: x'), undefined)).toMatchObject({ kind: 'block' });
    expect(store.turnEnds.currentTurn(S)).toEqual({ turnId: 1, blocks: 1 });
    expect(gate.take('tab-w')).toBeNull();
    expect(gate.takeTail('tab-w', S)).toBeNull();
    store.close();
  });

  it('keeps the payload message as the tail only for the bound session and only with the switch on', async () => {
    const { gate, store } = make();
    store.turnEnds.put(row());
    expect(await gate.decide('tab-w', tab, payload('x'.repeat(700) + '\nDONE: y'), undefined)).toMatchObject({ kind: 'row' });
    expect(gate.takeTail('tab-w', S)).toHaveLength(600);
    expect(gate.take('tab-w')).toMatchObject({ kind: 'row' });
    await gate.decide('tab-w', tab, payload('DONE: z', 'another-session'), undefined);
    expect(gate.takeTail('tab-w', S)).toBeNull();
    store.close();
    const off = make({ payloadIsTail: () => false });
    await off.gate.decide('tab-w', tab, payload('DONE: z'), undefined);
    expect(off.gate.takeTail('tab-w', S)).toBeNull();
    off.store.close();
  });

  it('blocks nothing without a payload message (a dropped body)', async () => {
    const { gate, store } = make();
    expect(await gate.decide('tab-w', tab, payload(null), undefined)).toMatchObject({ kind: 'classifier', why: 'no payload message' });
    store.close();
  });

  it('answers within its deadline: a hung open-work read lets the stop through', async () => {
    const { gate, store } = make({ openWork: () => new Promise(() => {}), deadlineMs: 50 });
    const started = Date.now();
    expect(await gate.decide('tab-w', tab, payload('working on it'), undefined)).toMatchObject({ kind: 'classifier', why: 'decision deadline' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(store.turnEnds.currentTurn(S)?.blocks).toBe(0);
    store.close();
  });

  it('review CONCERN: only idle_prompt with nothing since the hold makes it undelivered; any event confirms it', async () => {
    const { gate, store } = make();
    await gate.decide('tab-w', tab, payload('DONE: x'));
    // A tool call (a working tab, whatever its composer shows) confirms the hold: a later idle_prompt applies nothing.
    gate.onHookEvent('tab-w');
    expect(gate.onIdlePrompt('tab-w')).toBe(false);
    expect(gate.take('tab-w')).toBeNull();
    // A hold with nothing after it, then idle_prompt: UNREPORTED block-undelivered against the held turn.
    await gate.decide('tab-w', tab, payload('DONE: x'));
    store.turnEnds.bumpTurn(S, T0 + 5);
    expect(gate.onIdlePrompt('tab-w')).toBe(true);
    expect(gate.take('tab-w')).toEqual({ kind: 'unreported', reason: 'block-undelivered', escalation: null, turnId: 1 });
    expect(gate.onIdlePrompt('tab-w')).toBe(false);
    store.close();
  });

  it('review CONCERN: a done row written after the hold is applied at idle_prompt, never overwritten', async () => {
    const { gate, store } = make();
    await gate.decide('tab-w', tab, payload('DONE: x'));
    store.turnEnds.put(row());
    expect(gate.onIdlePrompt('tab-w')).toBe(true);
    expect(gate.take('tab-w')).toEqual({ kind: 'row', row: row() });
    store.close();
  });

  it('review CONCERN: an UNREPORTED write never replaces the worker\'s row; the row is kept and marked used', async () => {
    const { gate, store } = make();
    store.turnEnds.put(row({ reason: 'the worker\'s own' }));
    gate.writeUnreported(tab, 'tab-w', 'cap');
    expect(store.turnEnds.list('ws-1', 0)).toEqual([expect.objectContaining({ verdict: 'DONE', reason: 'the worker\'s own', consumedAt: T0 })]);
    store.close();
  });

  it('review nit 3: a replayed stop is judged and written against its own turn, not the current one', async () => {
    const { gate, store } = make();
    store.turnEnds.bumpTurn(S, T0 + 60_000);
    store.turnEnds.bumpTurn(S, T0 + 120_000);
    expect(store.turnEnds.turnAt(S, T0 + 30_000)).toBe(1);
    expect(store.turnEnds.turnAt(S, T0 - 1)).toBeNull();
    const decision = await gate.decide('tab-w', tab, payload('DONE: x'), T0 + 30_000);
    expect(decision).toEqual({ kind: 'unreported', reason: 'not-blockable:replayed', escalation: null, turnId: 1 });
    gate.writeUnreported(tab, 'tab-w', 'not-blockable:replayed', 1);
    expect(store.turnEnds.list('ws-1', 0)).toEqual([expect.objectContaining({ turnId: 1, verdict: 'UNREPORTED' })]);
    expect(store.turnEnds.unconsumed(S, 3)).toBeNull();
    // Its own turn's row, not the current turn's, is the one it applies.
    store.turnEnds.put(row({ turnId: 2, reason: 'turn two' }));
    expect(await gate.decide('tab-w', tab, payload('DONE: x'), T0 + 90_000)).toMatchObject({ kind: 'row', row: { turnId: 2 } });
    store.close();
  });

  it('consumes a row once', async () => {
    const { gate, store } = make();
    store.turnEnds.put(row());
    expect(gate.consume(row())).toBe(true);
    expect(gate.consume(row())).toBe(false);
    store.close();
  });
});
