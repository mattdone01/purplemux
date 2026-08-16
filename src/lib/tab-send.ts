import { isAgentPanelType } from '@/lib/agent-panel-types';
import type { ITab, TPanelType } from '@/types/terminal';
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
  panelType?: TPanelType;
}

/**
 * How long a send waits for a booting agent before giving up. A cold agent TUI
 * needs tens of seconds to reach a composer — trust prompt, MCP servers, hooks
 * — and a caller that dispatches a brief the moment it creates the tab is the
 * common case, not the exception.
 */
export const DEFAULT_SEND_READY_TIMEOUT_MS = 60_000;

export const MAX_SEND_READY_TIMEOUT_MS = 600_000;

export const SEND_READY_POLL_INTERVAL_MS = 500;

export const resolveSendWaitMs = (raw: unknown): number | null => {
  if (raw === undefined) return DEFAULT_SEND_READY_TIMEOUT_MS;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  if (raw < 0 || raw > MAX_SEND_READY_TIMEOUT_MS) return null;
  return raw;
};

export interface ISendReadinessDeps {
  findTarget: (workspaceId: string, tabId: string) => Promise<ITabSendTarget | null>;
  hasSession: (sessionName: string) => Promise<boolean>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ISendReadinessRequest {
  workspaceId: string;
  tabId: string;
  timeoutMs: number;
}

export type TSendReadiness =
  | { ok: true; target: ITabSendTarget }
  | { ok: false; reason: 'tab-not-found' }
  | { ok: false; reason: 'session-not-running'; cliState: TCliState | null }
  | { ok: false; reason: 'readiness-timeout'; cliState: TCliState | null; waitedMs: number };

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve a tab and hold until it can actually accept a paste, or until
 * `timeoutMs` expires.
 *
 * The single readiness definition behind both send routes. It exists because
 * pasting into an agent that has no composer yet is a silent failure: the text
 * lands in the TUI's input box, the trailing Enter is swallowed, and the caller
 * is told the send succeeded while the agent never takes a turn. Refusing —
 * with nothing pasted — is the only outcome a caller can act on.
 *
 * The state is re-resolved on every poll rather than once up front, so a tab
 * that is closed or whose session dies mid-wait is reported as such instead of
 * being pasted into at the deadline.
 *
 * `timeoutMs: 0` is a plain "answer now": one look, no sleep.
 */
export const awaitSendReadiness = async (
  deps: ISendReadinessDeps,
  request: ISendReadinessRequest,
): Promise<TSendReadiness> => {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? realSleep;
  const startedAt = now();

  for (;;) {
    const target = await deps.findTarget(request.workspaceId, request.tabId);
    if (!target) return { ok: false, reason: 'tab-not-found' };

    // Checked before the composer gate: a dead session never reaches a sendable
    // state, so waiting one out would trade an immediate diagnosis for a
    // deadline's worth of silence.
    if (!(await deps.hasSession(target.sessionName))) {
      return { ok: false, reason: 'session-not-running', cliState: target.cliState };
    }

    // The gate guards an agent composer. A terminal pane has no turn to accept
    // and no cliState to report, so it is delivered to unconditionally.
    if (!isAgentPanelType(target.panelType) || isSendableCliState(target.cliState)) {
      return { ok: true, target };
    }

    const waitedMs = now() - startedAt;
    const remainingMs = request.timeoutMs - waitedMs;
    if (remainingMs <= 0) {
      return { ok: false, reason: 'readiness-timeout', cliState: target.cliState, waitedMs };
    }
    await sleep(Math.min(SEND_READY_POLL_INTERVAL_MS, remainingMs));
  }
};

export interface ITabSendDeps extends ISendReadinessDeps {
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
  // The cookie-authed route answers a phone waiting on a tap, so it takes the
  // readiness verdict as it stands rather than holding the request open.
  const readiness = await awaitSendReadiness(deps, {
    workspaceId: request.workspaceId,
    tabId: request.tabId,
    timeoutMs: 0,
  });

  if (!readiness.ok) {
    if (readiness.reason === 'tab-not-found') return { status: 404, body: { error: 'tab-not-found' } };
    return {
      status: 409,
      body: {
        error: 'agent-not-ready',
        cliState: readiness.cliState,
        ...(readiness.reason === 'session-not-running' ? { detail: 'session-not-running' } : {}),
      },
    };
  }

  const target = readiness.target;

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
