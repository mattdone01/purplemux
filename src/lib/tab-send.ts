import type { ITab } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';

/**
 * A prompt is pasted into a TUI composer, not streamed, so the ceiling is about
 * what tmux and the agent can swallow in one paste rather than about storage.
 * 64 KB is far above any real prompt and well below the point where `send-keys`
 * starts to matter.
 */
export const MAX_SEND_CONTENT_BYTES = 64 * 1024;

/**
 * The states in which an agent has a composer that accepts a paste. Everything
 * else — `busy`, `inactive`, `unknown`, `cancelled` — is refused rather than
 * queued: a paste that lands mid-turn is the stray-input failure
 * `isContentPendingInComposer` exists to detect, and the caller has better
 * options (steer, or open the terminal).
 */
const SENDABLE_STATES: ReadonlySet<TCliState> = new Set<TCliState>([
  'idle',
  'ready-for-review',
  'needs-input',
]);

export const isSendableCliState = (state: TCliState | null | undefined): boolean =>
  state != null && SENDABLE_STATES.has(state);

/**
 * The live StatusManager entry is the truth; the layout copy is a persisted
 * echo that survives a restart and can lag a transition.
 */
export const resolveTabCliState = (
  tab: ITab,
  live: { cliState?: TCliState | null } | undefined,
): TCliState | null => live?.cliState ?? tab.cliState ?? null;

export interface ITabSendRequest {
  workspaceId: string;
  tabId: string;
  content: string;
  submit: boolean;
}

export type TTabSendParseResult =
  | { ok: true; request: ITabSendRequest }
  | { ok: false; error: 'bad-request' };

const single = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? undefined : value;

export const parseSendRequest = (
  query: Partial<Record<string, string | string[]>>,
  body: unknown,
): TTabSendParseResult => {
  const tabId = single(query.tabId);
  const workspaceId = single(query.workspaceId);
  if (!tabId || !workspaceId) return { ok: false, error: 'bad-request' };

  if (typeof body !== 'object' || body === null) return { ok: false, error: 'bad-request' };
  const { content, submit } = body as { content?: unknown; submit?: unknown };

  if (typeof content !== 'string' || content.trim() === '') return { ok: false, error: 'bad-request' };
  if (Buffer.byteLength(content, 'utf-8') > MAX_SEND_CONTENT_BYTES) return { ok: false, error: 'bad-request' };
  if (submit !== undefined && typeof submit !== 'boolean') return { ok: false, error: 'bad-request' };

  return { ok: true, request: { workspaceId, tabId, content, submit: submit ?? true } };
};

export interface ITabSendTarget {
  sessionName: string;
  cliState: TCliState | null;
}

export interface ITabSendDeps {
  findTarget: (workspaceId: string, tabId: string) => Promise<ITabSendTarget | null>;
  hasSession: (sessionName: string) => Promise<boolean>;
  paste: (sessionName: string, content: string) => Promise<void>;
  pasteWithoutSubmit: (sessionName: string, content: string) => Promise<void>;
  isContentPendingInComposer: (sessionName: string, content: string) => Promise<boolean>;
}

export type TTabSendResult =
  | { status: 200; body: { status: 'sent'; submitted: boolean; cliState: TCliState | null } }
  | { status: 404; body: { error: 'tab-not-found' } }
  | { status: 409; body: { error: 'agent-not-ready'; cliState: TCliState | null; detail?: string } };

export const performTabSend = async (
  deps: ITabSendDeps,
  request: ITabSendRequest,
): Promise<TTabSendResult> => {
  const target = await deps.findTarget(request.workspaceId, request.tabId);
  if (!target) return { status: 404, body: { error: 'tab-not-found' } };

  if (!isSendableCliState(target.cliState)) {
    return { status: 409, body: { error: 'agent-not-ready', cliState: target.cliState } };
  }

  if (!(await deps.hasSession(target.sessionName))) {
    return {
      status: 409,
      body: { error: 'agent-not-ready', cliState: target.cliState, detail: 'session-not-running' },
    };
  }

  if (!request.submit) {
    await deps.pasteWithoutSubmit(target.sessionName, request.content);
    return { status: 200, body: { status: 'sent', submitted: false, cliState: target.cliState } };
  }

  await deps.paste(target.sessionName, request.content);

  // Report delivery, not just dispatch: an agent that is mid-turn can swallow
  // the Enter, leaving the text in the composer for somebody else's keystroke
  // to submit. Best-effort and never fatal — the paste DID happen either way,
  // so a failed probe reads as submitted rather than as an error.
  const pending = await deps
    .isContentPendingInComposer(target.sessionName, request.content)
    .catch(() => false);

  return { status: 200, body: { status: 'sent', submitted: !pending, cliState: target.cliState } };
};
