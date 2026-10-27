import { describe, expect, it } from 'vitest';
import { InboxFieldError, noteFromWords, renderInboxLine } from '@/lib/inbox-templates';
import { createNote, viewOf } from '@/lib/notes-store';
import type { INote, INoteAdmission, INoteParty } from '@/types/note';

// Story 05 consult Q1: a note view's fromLabel is exactly the words the inbox
// note line prints after "from" — one function makes both, for every sender kind.

const T0 = Date.parse('2026-10-26T09:00:00.000Z');
const party = (workspaceId: string | null, tabId: string | null, extra: Partial<INoteParty> = {}): INoteParty =>
  ({ workspaceId, tabId, verified: workspaceId !== null, epic: null, ...extra });
const admit = (mode: INoteAdmission['mode'], sender: INoteAdmission['sender'], extra: Partial<INoteAdmission> = {}): INoteAdmission =>
  ({ mode, sender, authorizedAt: T0, ...extra });

const note = (from: INoteParty, admission: INoteAdmission | undefined): INote => {
  const n = createNote({ from, to: { epic: null, workspaceId: 'ws-2' }, subject: 's', body: 'b', admission: admission as INoteAdmission }, T0, 'n-label1');
  if (!admission) delete n.admission;
  return n;
};

/** The fields the notes service puts on a `note` notice. */
const fieldsOf = (n: INote) => ({
  noteId: n.id, fromWorkspaceId: n.from.workspaceId, fromTabId: n.from.tabId,
  fromHuman: n.admission?.mode === 'human', fromOwner: n.admission?.mode === 'owner', sentAt: n.createdAt,
});

const CASES: Array<[string, INote, string]> = [
  ['owner', note(party('ws-1', 'tab-o'), admit('owner', { workspaceId: 'ws-1', tabId: 'tab-o' }, { grantId: 'g-owner1' })), 'owner (ws-1/tab-o)'],
  ['coordinator', note(party('ws-1', 'tab-a'), admit('coordinator', { workspaceId: 'ws-1', tabId: 'tab-a' })), 'ws-1/tab-a'],
  ['local with a tab', note(party('ws-2', 'tab-w'), admit('local', { workspaceId: 'ws-2', tabId: 'tab-w' })), 'ws-2/tab-w'],
  ['a workspace sender with no tab', note(party('ws-2', null), admit('local', { workspaceId: 'ws-2', tabId: null })), 'ws-2/workspace'],
  ['admin', note(party(null, null), admit('local', { workspaceId: null, tabId: null })), 'admin'],
  ['human', note(party(null, null, { humanActor: 'human-1' }), admit('human', { workspaceId: null, tabId: null }, { humanActor: 'human-1', targetWorkspaceId: 'ws-2' })), 'human'],
  ['no admission (legacy)', note(party('ws-3', 'tab-c'), undefined), 'ws-3/tab-c'],
];

describe('note fromLabel (ADR-0029; consult Q1)', () => {
  it.each(CASES)('%s: the view label is the inbox line\'s from words', (_kind, n, expected) => {
    const view = viewOf(n, null);
    expect(view.fromLabel).toBe(expected);
    expect(renderInboxLine('note', fieldsOf(n)).line).toContain(`from ${view.fromLabel} at `);
  });

  it('fromOwner is true only for an owner admission', () => {
    for (const [, n] of CASES) expect(fieldsOf(n).fromOwner).toBe(n.admission?.mode === 'owner');
  });

  it('an owner label survives a revoke: it is the admission stored at send time', () => {
    const [, owner] = CASES[0];
    expect(viewOf({ ...owner, state: 'acked' }, null).fromLabel).toBe('owner (ws-1/tab-o)');
  });

  it('the inbox line refuses an owner notice without a sender workspace, or a non-boolean fromOwner', () => {
    expect(() => renderInboxLine('note', { noteId: 'n-label1', fromWorkspaceId: null, fromTabId: null, fromOwner: true, sentAt: T0 }))
      .toThrow(InboxFieldError);
    expect(() => renderInboxLine('note', { noteId: 'n-label1', fromWorkspaceId: 'ws-1', fromTabId: 'tab-o', fromOwner: 'yes' as unknown as boolean, sentAt: T0 }))
      .toThrow(InboxFieldError);
    expect(() => renderInboxLine('note', { noteId: 'n-label1', fromWorkspaceId: 'ws 1', fromTabId: 'tab-o', fromOwner: true, sentAt: T0 }))
      .toThrow(InboxFieldError);
  });

  it('a human sender wins over an owner flag: the words never claim both', () => {
    expect(noteFromWords({ workspaceId: 'ws-1', tabId: 'tab-o', human: true, owner: true })).toBe('human');
    expect(renderInboxLine('note', { noteId: 'n-label1', fromWorkspaceId: null, fromTabId: null, fromHuman: true, fromOwner: true, sentAt: T0 }).line)
      .toContain('from human at ');
  });
});
