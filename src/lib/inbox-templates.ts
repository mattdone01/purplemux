import type { TInboxKind } from '@/types/inbox';

// One fixed template per notice kind (ADR-0012). `deliverPrompt` submits the
// line as a user turn, so the line carries NO caller-supplied text: only
// server-made ids, server-resolved workspace and tab ids, server-computed
// times and counts, and — for a watch, which goes only to the tab that
// registered it — that tab's own validated target. An epic slug is not typed:
// any tab may hold `epic:<words>`, so it is read with `note show`.
// A field that fails its grammar is refused, never cleaned up: cleaning is how
// a subject would leak through one character class at a time.

export class InboxFieldError extends Error {
  readonly code = 'inbox-field-invalid' as const;
}

const GRAMMAR = {
  noteId: /^n-[A-Za-z0-9_-]{4,32}$/,
  watchId: /^w-[A-Za-z0-9_-]{4,32}$/,
  deployId: /^d-[A-Za-z0-9_-]{4,32}$/,
  resumeId: /^r-[A-Za-z0-9_-]{4,32}$/,
  // Server-made only: a UUID (answer ids) or a deterministic `<prefix>-<32 hex>`.
  // Producer-chosen Mission Control item ids ("question-1") are text, not ids.
  missionId: /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]{1,16}-[0-9a-f]{32})$/,
  workspaceId: /^ws-[A-Za-z0-9_-]{1,32}$/,
  tabId: /^tab-[A-Za-z0-9_-]{1,32}$/,
  // owner/repo#123, owner/repo@ref, or a lease name (lease-policy grammar).
  watchTarget: /^(?:[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}(?:#\d{1,7}|@[A-Za-z0-9_./-]{1,100})|[a-z][a-z0-9-]{1,31}:[a-z0-9._/@#:+-]{1,200})$/,
} as const;

type TGrammar = keyof typeof GRAMMAR;

const field = (name: string, value: unknown, grammar: TGrammar): string => {
  if (typeof value !== 'string' || !GRAMMAR[grammar].test(value)) {
    throw new InboxFieldError(`inbox field ${name} does not match its grammar (${grammar})`);
  }
  return value;
};

const time = (name: string, value: unknown): string => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 8.64e15) {
    throw new InboxFieldError(`inbox field ${name} must be an epoch-ms integer`);
  }
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
};

const count = (name: string, value: unknown): string => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 1_000_000) {
    throw new InboxFieldError(`inbox field ${name} must be a whole number`);
  }
  return String(value);
};

/** `fromWorkspaceId: null` is an admin-token sender; `fromTabId: null` a workspace token with no tab. */
export interface INoteFields { noteId: string; fromWorkspaceId: string | null; fromTabId: string | null; sentAt: number }
export interface IWatchFields { watchId: string; target: string; firedAt: number }
export interface IDeployFields { deployId: string; restartAt: number; quietSeconds: number }
export interface IMissionFields { answerId: string; workspaceId: string; readyAt: number }
export interface IResumeFields { resumeId: string }

export interface IInboxFields {
  note: INoteFields;
  watch: IWatchFields;
  deploy: IDeployFields;
  mission: IMissionFields;
  resume: IResumeFields;
}

type TRenderer<K extends TInboxKind> = (fields: IInboxFields[K]) => { recordId: string; line: string };

const TEMPLATES: { [K in TInboxKind]: TRenderer<K> } = {
  note: (f) => {
    const id = field('noteId', f.noteId, 'noteId');
    const from = f.fromWorkspaceId === null
      ? 'admin'
      : `${field('fromWorkspaceId', f.fromWorkspaceId, 'workspaceId')}/${f.fromTabId === null ? 'workspace' : field('fromTabId', f.fromTabId, 'tabId')}`;
    return { recordId: id, line: `[purplemux note ${id}] from ${from} at ${time('sentAt', f.sentAt)} — purplemux note show ${id}` };
  },
  watch: (f) => {
    const id = field('watchId', f.watchId, 'watchId');
    return { recordId: id, line: `[purplemux watch ${id}] ${field('target', f.target, 'watchTarget')} fired at ${time('firedAt', f.firedAt)} — purplemux watch show ${id}` };
  },
  deploy: (f) => {
    const id = field('deployId', f.deployId, 'deployId');
    return { recordId: id, line: `[purplemux deploy ${id}] purplemux restarts at ${time('restartAt', f.restartAt)} after a quiet wait of up to ${count('quietSeconds', f.quietSeconds)} s — purplemux deploy status ${id}` };
  },
  mission: (f) => {
    const id = field('answerId', f.answerId, 'missionId');
    return { recordId: id, line: `[purplemux mission ${id}] an answer is ready at ${time('readyAt', f.readyAt)} — purplemux mission answers -w ${field('workspaceId', f.workspaceId, 'workspaceId')}` };
  },
  // ADR-0018 amendment (story 26): the text is fixed; only the id varies.
  resume: (f) => {
    const id = field('resumeId', f.resumeId, 'resumeId');
    return { recordId: id, line: `[purplemux resume ${id}] the last turn ended on an API error — continue from where it was cut off` };
  },
};

export const renderInboxLine = <K extends TInboxKind>(kind: K, fields: IInboxFields[K]): { recordId: string; line: string } => {
  const render = TEMPLATES[kind] as TRenderer<K> | undefined;
  if (!render || !Object.hasOwn(TEMPLATES, kind)) throw new InboxFieldError(`unknown inbox kind ${String(kind)}`);
  if (typeof fields !== 'object' || fields === null) throw new InboxFieldError('inbox fields must be an object');
  return render(fields);
};

export const INBOX_KINDS = Object.keys(TEMPLATES) as TInboxKind[];
