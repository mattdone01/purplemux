import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, homedir: () => mockHome.value }, homedir: () => mockHome.value };
});

const load = () => import('@/lib/notes-store');

const T0 = Date.parse('2026-09-26T09:00:00.000Z');
const party = { workspaceId: 'ws-2', tabId: 'tab-b', verified: true, epic: null };

describe('notes store (ADR-0013)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-notes-'));
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).__ptNotesLock;
    await fs.rm(mockHome.value, { recursive: true, force: true });
  });

  it('cleans a subject to one line of at most 120 characters and refuses an empty one', async () => {
    const { cleanSubject, NoteError } = await load();
    expect(cleanSubject(' a\n\tb ‮\u0007c ')).toBe('a b c');
    expect([...cleanSubject('é'.repeat(300))]).toHaveLength(120);
    expect(() => cleanSubject('\n\t ')).toThrow(NoteError);
    expect(() => cleanSubject(42)).toThrow(NoteError);
  });

  it('allows a 16 KiB body and refuses one byte more, counting UTF-8 bytes', async () => {
    const { checkBody, NOTE_BODY_MAX_BYTES } = await load();
    expect(checkBody('x'.repeat(NOTE_BODY_MAX_BYTES))).toHaveLength(NOTE_BODY_MAX_BYTES);
    expect(() => checkBody('x'.repeat(NOTE_BODY_MAX_BYTES + 1))).toThrow(/16 KiB/);
    // 'é' is two bytes: 8193 of them are 16386 bytes.
    expect(() => checkBody('é'.repeat(8193))).toThrow(/16386 bytes/);
    expect(() => checkBody('  ')).toThrow(/required/);
  });

  it('wants exactly one target: an epic slug or a workspace id', async () => {
    const { checkTarget } = await load();
    expect(checkTarget('ddh', undefined)).toEqual({ epic: 'ddh', workspaceId: null });
    expect(checkTarget(undefined, 'ws-a')).toEqual({ epic: null, workspaceId: 'ws-a' });
    for (const [epic, ws] of [[undefined, undefined], ['ddh', 'ws-a'], ['Bad Slug', undefined], [undefined, 'tab-x']]) {
      expect(() => checkTarget(epic, ws)).toThrow(expect.objectContaining({ code: 'note-target-missing' }));
    }
  });

  it('show: the recipient workspace, the sender workspace or admin; ack: the routed recipient workspace only', async () => {
    const { createNote, routed, canShow, canAck } = await load();
    const queued = createNote({ from: party, to: { epic: null, workspaceId: 'ws-9' }, subject: 's', body: 'b' }, T0, 'n-abcdef');
    expect(canShow(queued, { workspaceId: 'ws-9', admin: false })).toBe(true);
    expect(canAck(queued, { workspaceId: 'ws-9' })).toBe(false);
    const note = routed(queued, { workspaceId: 'ws-1', tabId: 'tab-a' }, 'i-1', T0);
    expect(canShow(note, { workspaceId: 'ws-1', admin: false })).toBe(true);
    expect(canShow(note, { workspaceId: 'ws-2', admin: false })).toBe(true);
    expect(canShow(note, { workspaceId: 'ws-3', admin: false })).toBe(false);
    expect(canShow(note, { workspaceId: null, admin: true })).toBe(true);
    expect(canAck(note, { workspaceId: 'ws-1' })).toBe(true);
    expect(canAck(note, { workspaceId: 'ws-2' })).toBe(false);
  });

  it('prunes acked and expired notes 14 days after their transition, never open ones', async () => {
    const { createNote, acked, expired, prune, NOTE_PRUNE_MS } = await load();
    const base = createNote({ from: party, to: { epic: 'ddh', workspaceId: null }, subject: 's', body: 'b' }, T0, 'n-open01');
    const done = acked({ ...base, id: 'n-acked1' }, { workspaceId: 'ws-1', tabId: 'tab-a' }, null, T0);
    const gone = expired({ ...base, id: 'n-expir1' }, T0);
    const state = { notes: [base, done, gone] };
    expect(prune(state, T0 + NOTE_PRUNE_MS - 1)).toBe(state);
    expect(prune(state, T0 + NOTE_PRUNE_MS).notes.map((n) => n.id)).toEqual(['n-open01']);
  });

  it('writes notes.json with mode 0600 and refuses a malformed file rather than reading it as empty', async () => {
    const { mutateNotes, readNotesState, notesFile, createNote } = await load();
    const note = createNote({ from: party, to: { epic: 'ddh', workspaceId: null }, subject: 's', body: 'b' }, T0, 'n-abcdef');
    await mutateNotes((state) => ({ state: { notes: [...state.notes, note] }, value: undefined }));
    expect((await fs.stat(notesFile())).mode & 0o777).toBe(0o600);
    expect((await readNotesState()).notes).toHaveLength(1);
    await fs.writeFile(notesFile(), JSON.stringify({ notes: [{ id: 'bogus' }] }));
    await expect(readNotesState()).rejects.toThrow(/malformed/);
    await fs.writeFile(notesFile(), '{"nope":1}');
    await expect(readNotesState()).rejects.toThrow(/no "notes" array/);
  });
});
