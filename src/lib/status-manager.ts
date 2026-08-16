import { WebSocket } from 'ws';
import { getWorkspaces, getWorkspaceByIdCached, getWorkspacesCached } from '@/lib/workspace-store';
import { readLayoutFile, resolveLayoutFile, collectAllTabs, updateTabCliStatus, updateTabAgentSummary, updateTabAgentState, parseSessionName, setLayoutReconciler } from '@/lib/layout-store';
import { getAllPanesInfo, getListeningPorts, SAFE_SHELLS, getPaneTitle, getSessionCwd, getSessionPanePid, hasSession, sendBracketedPaste } from '@/lib/tmux';
import { getChildPids } from '@/lib/process-utils';
import { getProvider, getProviderByPanelType } from '@/lib/providers/registry';
import { detectAnyActiveSession } from '@/lib/providers/session-scan';
import type { IAgentProvider } from '@/lib/providers/types';
import type { IAgentHookMetaPatch, TAgentWorkStateEvent } from '@/lib/providers/types';
import { deriveAgentCliState } from '@/lib/agent-state-transition';
import { cwdToProjectPath } from '@/lib/session-list';
import { formatTabTitle } from '@/lib/tab-title';
import { createRateLimitsWatcher } from '@/lib/rate-limits-watcher';
import { createLogger } from '@/lib/logger';
import { capturePaneAtWidth } from '@/lib/capture-at-width';
import { isCodexTuiReadyContent } from '@/lib/codex-tui-ready-detector';
import { CODEX_PROVIDER_ID } from '@/lib/providers/codex';
import { GROK_PROVIDER_ID } from '@/lib/providers/grok';
import { resolveGrokJsonlPath } from '@/lib/providers/grok/session-detection';
import { isAgentPanelType, toSessionHistoryProvider } from '@/lib/agent-panel-types';
import { runtimeHandleFor, runtimeProviderId } from '@/lib/agent-runtime-handle';
import { findCodexSessionById } from '@/lib/providers/codex/session-detection';
import { cacheCodexRateLimitsFromJsonl } from '@/lib/codex-rate-limits-cache';
import { parsePermissionOptions } from '@/lib/permission-prompt';
import type { IPaneInfo } from '@/lib/tmux';
import type { ITab, IWorkspace } from '@/types/terminal';
import type { TCliState } from '@/types/timeline';
import type { ICurrentAction, TTerminalStatus, ITabStatusEntry, IClientTabStatusEntry, IStatusUpdateMessage, IRateLimitsCache, TEventName, ILastEvent, IOrchestrationNudge, TOrchestrationNudgeKind, IWorkspaceStandup, TAlertKind, TAlertProviderId } from '@/types/status';
import { addStandup, readAllLatestStandups } from '@/lib/standup-store';
import { buildNudgeMessage, buildHeartbeatMessage, nudgeKindForTransition, NUDGE_DEBOUNCE_MS, MAX_NUDGE_HISTORY, KICKOFF_FALLBACK_DELAY_MS, ORCH_IDLE_HEARTBEAT_MS, ORCH_MAX_HEARTBEATS } from '@/lib/orchestration';
import { getSignalEngine } from '@/lib/signal-engine';
import type { IAgentSignal, IToolActivity } from '@/types/signals';
import type { ISessionHistoryEntry } from '@/types/session-history';
import { addSessionHistoryEntry, updateSessionHistoryDismissedAt } from '@/lib/session-history';
import { alertFor, isOrchestratorTab, isStallEpisodeEnd, shouldAlert, standupAlertTabId } from '@/lib/alert-policy';
import { createStatusSocketChannel, createWebPushChannel, getNotificationDispatcher } from '@/lib/notification-dispatcher';
import { getConfig } from '@/lib/config-store';
import { nanoid } from 'nanoid';
import fs from 'fs/promises';
import { watch, type FSWatcher } from 'fs';

const toAlertProvider = (providerId: string | undefined): TAlertProviderId =>
  providerId === 'codex' || providerId === 'grok' ? providerId : 'claude';

const log = createLogger('status');
const hookLog = createLogger('hooks');

const entryAgentFields = (
  provider: IAgentProvider | null,
  tab: ITab,
  jsonlPath: string | null | undefined,
): { agentProviderId?: string; agentSessionId: string | null; agentSummary: string | null } => ({
  agentProviderId: provider?.id,
  agentSummary: provider?.readSummary(tab) ?? null,
  agentSessionId: provider?.sessionIdFromJsonlPath(jsonlPath ?? null)
    ?? provider?.readSessionId(tab)
    ?? null,
});

// Notification hook의 notification_type 중 권한 요청류만 needs-input으로 전환.
// idle_prompt(응답 후 60s idle 알람), computer_use_*, elicitation_*, auth_success 등은 상태 변경 없이 무시한다.
const INPUT_REQUESTING_NOTIFICATION_TYPES = new Set(['permission_prompt', 'worker_permission_prompt']);

const COMPACT_STALE_MS = 60_000;

// A tab's scope is set at creation and effectively never changes, so a long TTL
// keeps the layout read off the per-tool-call path.
const TAB_SCOPE_TTL_MS = 5 * 60_000;

const POLL_INTERVAL_SMALL = 30_000;
const POLL_INTERVAL_MEDIUM = 45_000;
const POLL_INTERVAL_LARGE = 60_000;
const TAB_COUNT_MEDIUM = 11;
const TAB_COUNT_LARGE = 21;
const BUSY_STUCK_MS = 10 * 60 * 1000;
const AGENT_LAUNCH_GRACE_MS = 5_000;
const AGENT_GUARDED_STATES: Set<TCliState> = new Set(['busy', 'idle', 'needs-input', 'ready-for-review']);
// tmux set-titles emits "<cmd>|<path>" once a shell takes over the pane.
// An agent CLI normally writes its own title (no pipe), so this regex
// distinguishes "agent gone" from "agent rewrote title" without a process call.
const SHELL_TITLE_RE = /^[^|]+\|[^|]+$/;
const PROCESS_RETRY_COUNT = 3;
const JSONL_WATCH_DEBOUNCE_MS = 100;
const LAUNCH_READY_POLL_DELAYS_MS = [700, 1_500, 3_000, 5_000, 8_000] as const;

const g = globalThis as unknown as { __ptStatusManager?: StatusManager };

class StatusManager {
  private tabs = new Map<string, ITabStatusEntry>();
  private pollingTimer: ReturnType<typeof setInterval> | null = null;
  private currentInterval = 0;
  private clients = new Set<WebSocket>();
  private initialized = false;
  private rateLimitsWatcher: ReturnType<typeof createRateLimitsWatcher> | null = null;
  private lastRateLimits: IRateLimitsCache | null = null;
  private jsonlWatchers = new Map<string, { watcher: FSWatcher; jsonlPath: string; debounceTimer: ReturnType<typeof setTimeout> | null }>();
  private compactStaleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private orchestrationNudges: IOrchestrationNudge[] = [];
  private standups = new Map<string, IWorkspaceStandup>();

  // Scope/cwd are read from the layout file, which is far too slow to touch per
  // tool call. Cached with a short TTL and refreshed off the hot path.
  private tabScopeCache = new Map<string, { scope?: string[]; cwd?: string; at: number }>();
  private orchKeeper = new Map<string, { idleSince: number | null; beats: number; lastBeatAt: number; stallAlerted: boolean }>();
  private lastNudgeByTab = new Map<string, { kind: TOrchestrationNudgeKind; at: number }>();
  private stuckNudgedTabs = new Set<string>();
  private pendingKickoffs = new Map<string, { prompt: string; timer: ReturnType<typeof setTimeout> }>();

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    getSignalEngine().setEmitter((signal) => this.deliverSignal(signal));

    // Standups are file-backed so "where are things at" survives a restart;
    // ticks posted while hydration is in flight win via the at-comparison.
    readAllLatestStandups().then((latest) => {
      for (const [wsId, standup] of Object.entries(latest)) {
        const current = this.standups.get(wsId);
        if (!current || current.at < standup.at) this.standups.set(wsId, standup);
      }
    }).catch(() => {});

    await this.scanAll();
    this.startPolling();

    this.rateLimitsWatcher = createRateLimitsWatcher((data) => {
      this.lastRateLimits = data;
      this.broadcast({ type: 'rate-limits:update', data });
    });
    this.rateLimitsWatcher.start();
  }

  private async scanAll(): Promise<void> {
    const { workspaces } = await getWorkspaces();
    const panesInfo = await getAllPanesInfo();
    for (const tabId of [...this.jsonlWatchers.keys()]) {
      this.stopJsonlWatch(tabId);
    }
    this.tabs.clear();

    for (const ws of workspaces) {
      const layout = await readLayoutFile(resolveLayoutFile(ws.id));
      if (!layout) continue;

      const tabs = collectAllTabs(layout.root);
      for (const tab of tabs) {
        const paneInfo = panesInfo.get(tab.sessionName);
        const provider = getProviderByPanelType(tab.panelType);
        const detected = await this.readTabMetadata(paneInfo, provider, tab);
        const persisted: TCliState = (tab.cliState as TCliState | undefined) ?? 'idle';
        const cliState: TCliState = persisted === 'busy' ? 'unknown' : persisted;

        const { terminalStatus, listeningPorts } = provider
          ? { terminalStatus: 'idle' as const, listeningPorts: [] as number[] }
          : await this.detectTerminalStatus(paneInfo);
        const currentProcess = paneInfo?.command;
        const paneTitle = paneInfo ? `${paneInfo.command}|${paneInfo.path}` : undefined;
        // lastEvent는 메모리 전용이라 재시작 시 유실. persisted needs-input 복원 시
        // 클라 ack가 seq=0과 매칭할 baseline이 필요하므로 합성한다.
        const syntheticLastEvent: ILastEvent | null = cliState === 'needs-input'
          ? { name: 'notification', at: Date.now(), seq: 0 }
          : null;
        this.tabs.set(tab.id, {
          cliState,
          workspaceId: ws.id,
          tabName: tab.name || (paneTitle ? formatTabTitle(paneTitle, tab.panelType) : ''),
          currentProcess,
          paneTitle,
          tmuxSession: tab.sessionName,
          panelType: tab.panelType,
          terminalStatus,
          listeningPorts,
          ...entryAgentFields(provider, tab, detected.jsonlPath),
          lastUserMessage: tab.lastUserMessage,
          lastAssistantMessage: detected.lastAssistantSnippet,
          currentAction: detected.currentAction,
          readyForReviewAt: cliState === 'ready-for-review' ? Date.now() : null,
          busySince: null,
          dismissedAt: tab.dismissedAt ?? null,
          jsonlPath: detected.jsonlPath,
          lastEvent: syntheticLastEvent,
          eventSeq: 0,
        });
        if ((cliState === 'needs-input' || cliState === 'unknown') && detected.jsonlPath) {
          this.startJsonlWatch(tab.id, detected.jsonlPath);
        }
        if (cliState === 'unknown') {
          this.resolveUnknown(tab.id).catch((err) => log.warn('resolveUnknown failed: %s', err));
        }
      }
    }
  }

  private async resolveUnknown(tabId: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.cliState !== 'unknown') return;

    const provider = getProviderByPanelType(entry.panelType);
    const paneInfo = (await getAllPanesInfo()).get(entry.tmuxSession);
    const childPids = paneInfo?.pid ? await getChildPids(paneInfo.pid) : [];
    const agentRunning = paneInfo?.pid && provider
      ? await provider.isAgentRunning(paneInfo.pid, childPids)
      : false;

    if (!agentRunning) {
      this.applyCliState(tabId, entry, 'idle', { silent: true });
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
      return;
    }

    const unknownStateHandle = this.runtimeHandle(entry);
    if (provider && unknownStateHandle) {
      const { idle, stale, lastAssistantSnippet } = await provider.readRuntimeSnapshot(unknownStateHandle);
      if (idle && !stale && lastAssistantSnippet) {
        this.applyCliState(tabId, entry, 'ready-for-review', { silent: true });
        this.persistToLayout(entry);
        this.broadcastUpdate(tabId, entry);
        return;
      }
    }
  }

  private async readTabMetadata(
    paneInfo: IPaneInfo | undefined,
    provider: IAgentProvider | null,
    tab?: ITab,
  ): Promise<{ lastAssistantSnippet: string | null; currentAction: ICurrentAction | null; jsonlPath: string | null }> {
    const empty = { lastAssistantSnippet: null, currentAction: null, jsonlPath: null };
    if (!paneInfo || !paneInfo.pid || !provider) return empty;

    const childPids = await getChildPids(paneInfo.pid);
    const running = await provider.isAgentRunning(paneInfo.pid, childPids);
    if (!running) return empty;

    if (tab) {
      const persistedJsonlPath = provider.readJsonlPath(tab);
      if (persistedJsonlPath) {
        try {
          await fs.access(persistedJsonlPath);
          const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(persistedJsonlPath);
          return { lastAssistantSnippet, currentAction, jsonlPath: persistedJsonlPath };
        } catch { /* fall through */ }
      }

      // Codex and grok both key their stores by their own index rather than by
      // the pane's cwd, so a persisted session id resolves to a transcript
      // without re-detecting the process.
      const persistedSessionId = provider.readSessionId(tab);
      if (persistedSessionId) {
        const storeJsonlPath = provider.id === CODEX_PROVIDER_ID
          ? (await findCodexSessionById(persistedSessionId))?.jsonlPath ?? null
          : provider.id === GROK_PROVIDER_ID
            ? await resolveGrokJsonlPath(persistedSessionId)
            : null;
        const handle = runtimeHandleFor(provider.id, {
          jsonlPath: storeJsonlPath,
          sessionId: persistedSessionId,
        });
        if (handle) {
          const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(handle);
          return { lastAssistantSnippet, currentAction, jsonlPath: storeJsonlPath };
        }
      }
    }

    const session = await provider.detectActiveSession(paneInfo.pid, childPids);
    if (session.status !== 'running' || !session.jsonlPath) {
      return { lastAssistantSnippet: null, currentAction: null, jsonlPath: session.jsonlPath ?? null };
    }

    const { lastAssistantSnippet, currentAction } = await provider.readRuntimeSnapshot(session.jsonlPath);
    return { lastAssistantSnippet, currentAction, jsonlPath: session.jsonlPath };
  }

  private async detectTerminalStatus(
    paneInfo?: IPaneInfo,
  ): Promise<{ terminalStatus: TTerminalStatus; listeningPorts: number[] }> {
    if (!paneInfo || !paneInfo.pid) return { terminalStatus: 'idle', listeningPorts: [] };

    const ports = await getListeningPorts(paneInfo.pid);
    if (ports.length > 0) return { terminalStatus: 'server', listeningPorts: ports };

    const isShell = SAFE_SHELLS.has(paneInfo.command);
    return { terminalStatus: isShell ? 'idle' : 'running', listeningPorts: [] };
  }

  private getPollingInterval(): number {
    const count = this.tabs.size;
    if (count >= TAB_COUNT_LARGE) return POLL_INTERVAL_LARGE;
    if (count >= TAB_COUNT_MEDIUM) return POLL_INTERVAL_MEDIUM;
    return POLL_INTERVAL_SMALL;
  }

  async rescan(): Promise<void> {
    await this.scanAll();
  }

  startPolling(): void {
    this.stopPolling();
    this.currentInterval = this.getPollingInterval();
    this.pollingTimer = setInterval(() => {
      this.poll().catch((err) => {
        log.error({ err }, 'Polling error');
      });
    }, this.currentInterval);
  }

  stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
      this.currentInterval = 0;
    }
  }

  async poll(): Promise<void> {
    const { workspaces } = await getWorkspaces();
    const panesInfo = await getAllPanesInfo();
    const knownTabIds = new Set<string>();
    const tabsBeforePoll = new Set(this.tabs.keys());
    const now = Date.now();

    for (const ws of workspaces) {
      const layout = await readLayoutFile(resolveLayoutFile(ws.id));
      if (!layout) continue;

      const tabs = collectAllTabs(layout.root);
      for (const tab of tabs) {
        knownTabIds.add(tab.id);
        const existing = this.tabs.get(tab.id);
        const paneInfo = panesInfo.get(tab.sessionName);
        const provider = getProviderByPanelType(tab.panelType);

        const { terminalStatus, listeningPorts } = provider
          ? { terminalStatus: 'idle' as const, listeningPorts: [] as number[] }
          : await this.detectTerminalStatus(paneInfo);
        const currentProcess = paneInfo?.command;
        const newPaneTitle = paneInfo ? `${paneInfo.command}|${paneInfo.path}` : undefined;

        if (!existing) {
          const persisted: TCliState = (tab.cliState as TCliState | undefined) ?? 'idle';
          const initialState: TCliState = persisted === 'busy' ? 'unknown' : persisted;
          const detected = await this.readTabMetadata(paneInfo, provider, tab);
          // lastEvent는 메모리 전용이라 재시작 시 유실. persisted needs-input을 복원할 때는
          // 클라이언트 ack가 seq=0과 매칭할 baseline이 필요하므로 합성한다.
          const syntheticLastEvent: ILastEvent | null = initialState === 'needs-input'
            ? { name: 'notification', at: Date.now(), seq: 0 }
            : null;
          const entry: ITabStatusEntry = {
            cliState: initialState,
            workspaceId: ws.id,
            tabName: tab.name || (newPaneTitle ? formatTabTitle(newPaneTitle, tab.panelType) : ''),
            currentProcess,
            paneTitle: newPaneTitle,
            tmuxSession: tab.sessionName,
            panelType: tab.panelType,
            terminalStatus,
            listeningPorts,
            ...entryAgentFields(provider, tab, detected.jsonlPath),
            lastUserMessage: tab.lastUserMessage,
            lastAssistantMessage: detected.lastAssistantSnippet,
            currentAction: detected.currentAction,
            jsonlPath: detected.jsonlPath,
            lastEvent: syntheticLastEvent,
            eventSeq: 0,
          };
          this.tabs.set(tab.id, entry);
          this.persistToLayout(entry);
          this.broadcastUpdate(tab.id, entry);
          if (initialState === 'unknown') {
            this.resolveUnknown(tab.id).catch((err) => log.warn('resolveUnknown failed: %s', err));
          }
          continue;
        }

        const processChanged = existing.currentProcess !== currentProcess;
        const messageChanged = existing.lastUserMessage !== tab.lastUserMessage;
        const panelTypeChanged = existing.panelType !== tab.panelType;
        const refreshed = await this.readTabMetadata(paneInfo, provider, tab);
        existing.tabName = tab.name || (newPaneTitle ? formatTabTitle(newPaneTitle, tab.panelType) : '');
        existing.currentProcess = currentProcess;
        existing.paneTitle = newPaneTitle;
        existing.workspaceId = ws.id;
        existing.panelType = tab.panelType;
        existing.agentProviderId = provider?.id;
        existing.agentSessionId = provider?.sessionIdFromJsonlPath(refreshed.jsonlPath)
          ?? provider?.readSessionId(tab) ?? null;
        existing.jsonlPath = refreshed.jsonlPath ?? existing.jsonlPath;
        existing.lastUserMessage = tab.lastUserMessage;

        if (processChanged) {
          existing.processRetries = PROCESS_RETRY_COUNT;
        }
        const processRetryNeeded = !processChanged && (existing.processRetries ?? 0) > 0;
        if (processRetryNeeded) {
          existing.processRetries = existing.processRetries! - 1;
        }

        const prevPorts = existing.listeningPorts;
        const portsChanged = prevPorts?.length !== listeningPorts.length
          || listeningPorts.some((p, i) => prevPorts![i] !== p);
        const terminalChanged = existing.terminalStatus !== terminalStatus || portsChanged;
        if (terminalChanged) {
          existing.terminalStatus = terminalStatus;
          existing.listeningPorts = listeningPorts;
        }

        let summaryChanged = false;
        const tabSummary = provider ? provider.readSummary(tab) : null;
        if (existing.cliState === 'busy' || existing.cliState === 'needs-input') {
          const paneTitle = await getPaneTitle(tab.sessionName);
          const liveSummary = provider?.parsePaneTitle(paneTitle) ?? null;
          const nextSummary = liveSummary ?? tabSummary;
          if (nextSummary !== existing.agentSummary) {
            existing.agentSummary = nextSummary;
            summaryChanged = true;
            if (liveSummary && provider) {
              updateTabAgentSummary(tab.sessionName, provider, liveSummary).catch(() => {});
            }
          }
        } else {
          if (existing.agentSummary !== tabSummary) {
            existing.agentSummary = tabSummary;
            summaryChanged = true;
          }
        }

        let agentRunningCache: boolean | null = null;
        const checkAgentRunning = async (): Promise<boolean> => {
          if (agentRunningCache !== null) return agentRunningCache;
          if (!paneInfo?.pid || !provider) {
            agentRunningCache = false;
            return false;
          }
          const childPids = await getChildPids(paneInfo.pid);
          agentRunningCache = await provider.isAgentRunning(paneInfo.pid, childPids);
          return agentRunningCache;
        };

        if (existing.cliState === 'busy' && existing.lastEvent
            && now - existing.lastEvent.at > BUSY_STUCK_MS) {
          if (!(await checkAgentRunning())) {
            log.info({ tabId: tab.id }, 'busy stuck — agent process gone, forcing idle');
            this.applyCliState(tab.id, existing, 'idle', { silent: true });
            this.persistToLayout(existing);
            this.broadcastUpdate(tab.id, existing);
            continue;
          }
          if (!this.stuckNudgedTabs.has(tab.id) && !(await this.hasRecentJsonlActivity(existing, now))) {
            this.stuckNudgedTabs.add(tab.id);
            this.nudgeOrchestrator(tab.id, existing, 'stuck').catch((err) => {
              log.warn(`stuck nudge failed: ${err instanceof Error ? err.message : err}`);
            });
          }
        }

        if (provider && AGENT_GUARDED_STATES.has(existing.cliState)) {
          const stamp = existing.lastResumeOrStartedAt;
          const inGrace = stamp !== undefined && now - stamp < AGENT_LAUNCH_GRACE_MS;
          if (!inGrace) {
            const title = existing.paneTitle ?? '';
            const titleShellStyle = !!title && SHELL_TITLE_RE.test(title);
            if ((!title || titleShellStyle) && !(await checkAgentRunning())) {
              log.info({ tabId: tab.id, prevState: existing.cliState }, 'agent process gone — transitioning to inactive');
              this.applyCliState(tab.id, existing, 'inactive', { silent: true });
              this.persistToLayout(existing);
              this.broadcastUpdate(tab.id, existing);
              continue;
            }
          }
        }

        if (existing.cliState === 'inactive' && existing.panelType === 'codex-cli' && provider) {
          if (await this.checkCodexTuiReady(existing, checkAgentRunning)) {
            hookLog.debug({ tabId: tab.id }, 'codex tui ready — synthetic session-start');
            this.updateTabFromHook(existing.tmuxSession, 'session-start');
            continue;
          }
        }

        if (terminalChanged || processChanged || processRetryNeeded || messageChanged || panelTypeChanged || summaryChanged) {
          this.broadcastUpdate(tab.id, existing);
        }
      }
    }

    for (const tabId of tabsBeforePoll) {
      if (!knownTabIds.has(tabId) && this.tabs.has(tabId)) {
        this.stopJsonlWatch(tabId);
        this.tabs.delete(tabId);
        this.lastNudgeByTab.delete(tabId);
        this.stuckNudgedTabs.delete(tabId);
        this.clearPendingKickoff(tabId);
        this.broadcastRemove(tabId);
      }
    }

    const newInterval = this.getPollingInterval();
    if (this.pollingTimer && newInterval !== this.currentInterval) {
      this.startPolling();
    }

    await this.runOrchestratorKeeper().catch((err) => {
      log.warn(`orchestrator keeper failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  // 워커는 상태 전환 훅이 깨워주지만, 워커가 하나도 없을 때 orchestrator가
  // idle로 잠들면 아무것도 깨우지 못한다 — 그 유일한 사각을 keeper가 메운다.
  private async runOrchestratorKeeper(): Promise<void> {
    const workspaces = (await getWorkspacesCached())?.workspaces ?? [];
    const now = Date.now();
    for (const ws of workspaces) {
      const orch = ws.orchestration;
      if (!orch?.enabled || !orch.orchestratorTabId) { this.orchKeeper.delete(ws.id); continue; }
      const entry = this.tabs.get(orch.orchestratorTabId);
      if (!entry) { this.orchKeeper.delete(ws.id); continue; }

      const state = this.orchKeeper.get(ws.id) ?? { idleSince: null, beats: 0, lastBeatAt: 0, stallAlerted: false };
      const workersActive = [...this.tabs.entries()].some(([id, t]) =>
        id !== orch.orchestratorTabId && t.workspaceId === ws.id
        && isAgentPanelType(t.panelType)
        && (t.cliState === 'busy' || t.cliState === 'needs-input' || t.cliState === 'ready-for-review'));

      // busy = working; needs-input = waiting on the HUMAN (the alert already fired) — do not nag.
      if (entry.cliState === 'busy' || entry.cliState === 'needs-input' || workersActive) {
        this.orchKeeper.set(ws.id, { idleSince: null, beats: 0, lastBeatAt: 0, stallAlerted: false });
        continue;
      }
      if (entry.cliState !== 'idle' && entry.cliState !== 'ready-for-review') continue;

      if (state.idleSince === null) {
        this.orchKeeper.set(ws.id, { ...state, idleSince: now });
        continue;
      }
      if (now - state.idleSince < ORCH_IDLE_HEARTBEAT_MS || now - state.lastBeatAt < ORCH_IDLE_HEARTBEAT_MS) continue;
      if (state.beats >= ORCH_MAX_HEARTBEATS) continue;

      const idleMinutes = Math.round((now - state.idleSince) / 60_000);
      const message = buildHeartbeatMessage(idleMinutes, ws.id);
      let delivered = false;
      if (await hasSession(entry.tmuxSession)) {
        try {
          await sendBracketedPaste(entry.tmuxSession, message);
          delivered = true;
        } catch (err) {
          log.warn(`orchestrator heartbeat delivery failed: ${err instanceof Error ? err.message : err}`);
        }
      }
      const beats = state.beats + 1;
      // Last heartbeat of the episode: the orchestrator slept through every
      // nudge purplemux can send, so the human is the only one left to ask.
      const stalled = isStallEpisodeEnd(beats, ORCH_MAX_HEARTBEATS, state.stallAlerted);
      this.orchKeeper.set(ws.id, { ...state, beats, lastBeatAt: now, stallAlerted: state.stallAlerted || stalled });
      if (stalled) {
        void this.dispatchStallAlert(ws, entry, orch.orchestratorTabId, idleMinutes).catch((err) => {
          log.warn(`orchestrator stall alert failed: ${err instanceof Error ? err.message : err}`);
        });
      }
      const nudge: IOrchestrationNudge = {
        id: nanoid(8),
        workspaceId: ws.id,
        tabId: orch.orchestratorTabId,
        tabName: entry.tabName,
        kind: 'heartbeat',
        message,
        at: now,
        delivered,
      };
      this.orchestrationNudges.push(nudge);
      if (this.orchestrationNudges.length > MAX_NUDGE_HISTORY) {
        this.orchestrationNudges.splice(0, this.orchestrationNudges.length - MAX_NUDGE_HISTORY);
      }
      this.broadcast({ type: 'orchestration:nudge', nudge });
      log.info({ workspaceId: ws.id, beats, delivered }, 'orchestrator heartbeat');
    }
  }

  private async dispatchStallAlert(ws: IWorkspace, entry: ITabStatusEntry, tabId: string, idleMinutes: number): Promise<void> {
    if (!shouldAlert({ id: tabId }, ws, await getConfig())) return;
    await this.dispatchAlert({
      kind: 'orchestrator-stalled',
      tabId,
      workspace: ws,
      workspaceId: ws.id,
      tabName: entry.tabName,
      providerId: toAlertProvider(entry.agentProviderId),
      agentSessionId: entry.agentSessionId,
      detail: `Idle ~${idleMinutes} min with no worker activity after ${ORCH_MAX_HEARTBEATS} heartbeats.`,
    });
  }

  getAllForClient(): Record<string, IClientTabStatusEntry> {
    const result: Record<string, IClientTabStatusEntry> = {};
    for (const [tabId, entry] of this.tabs) {
      result[tabId] = {
        cliState: entry.cliState,
        workspaceId: entry.workspaceId,
        tabName: entry.tabName,
        currentProcess: entry.currentProcess,
        paneTitle: entry.paneTitle,
        panelType: entry.panelType,
        terminalStatus: entry.terminalStatus,
        listeningPorts: entry.listeningPorts,
        agentProviderId: entry.agentProviderId,
        agentSummary: entry.agentSummary,
        lastUserMessage: entry.lastUserMessage,
        lastAssistantMessage: entry.lastAssistantMessage,
        currentAction: entry.currentAction,
        readyForReviewAt: entry.readyForReviewAt,
        busySince: entry.busySince,
        dismissedAt: entry.dismissedAt,
        agentSessionId: entry.agentSessionId,
        compactingSince: entry.compactingSince,
        permissionRequest: entry.permissionRequest,
        lastEvent: entry.lastEvent,
        eventSeq: entry.eventSeq,
      };
    }
    return result;
  }

  private applyCliState(tabId: string, entry: ITabStatusEntry, newState: TCliState, opts: { silent?: boolean } = {}): void {
    const prevState = entry.cliState;
    if (prevState === newState) return;
    const prevBusySince = entry.busySince;
    entry.cliState = newState;
    entry.readyForReviewAt = newState === 'ready-for-review' ? Date.now() : null;
    entry.busySince = newState === 'busy' ? Date.now() : null;
    if (newState === 'busy') entry.dismissedAt = null;
    if (prevState === 'needs-input' && newState !== 'needs-input' && entry.permissionRequest) {
      entry.permissionRequest = null;
    }

    if (newState === 'ready-for-review' && entry.jsonlPath) {
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      delay(500).then(() => this.saveSessionHistory(tabId, entry, prevBusySince, false)).catch((err) => {
        log.warn('Failed to save session history: %s', err);
      });
    }

    if (newState === 'ready-for-review' && !opts.silent) {
      void this.dispatchTransitionAlert(tabId, entry, 'review');
    }

    if (newState === 'needs-input' && !opts.silent) {
      void this.dispatchTransitionAlert(tabId, entry, 'needs-input');
    }

    const shouldWatch = (newState === 'busy' || newState === 'needs-input') && entry.jsonlPath;
    const keepForFinalRead = newState === 'ready-for-review' && this.jsonlWatchers.has(tabId);
    if (shouldWatch && !this.jsonlWatchers.has(tabId)) {
      this.startJsonlWatch(tabId, entry.jsonlPath!);
    } else if (!shouldWatch && !keepForFinalRead && this.jsonlWatchers.has(tabId)) {
      this.stopJsonlWatch(tabId);
    }

    if (newState !== 'busy') this.stuckNudgedTabs.delete(tabId);
    if (newState === 'idle' && this.pendingKickoffs.has(tabId)) {
      this.deliverKickoff(tabId);
    }
    const nudgeKind = nudgeKindForTransition(prevState, newState, !!opts.silent);
    if (nudgeKind) {
      this.nudgeOrchestrator(tabId, entry, nudgeKind).catch((err) => {
        log.warn(`orchestrator nudge failed: ${err instanceof Error ? err.message : err}`);
      });
    }
  }

  // Every channel — web push, the status socket, and the client-side Electron
  // and toast hooks — asks alert-policy the same question. See docs/STATUS.md.
  private async dispatchTransitionAlert(tabId: string, entry: ITabStatusEntry, kind: 'review' | 'needs-input'): Promise<void> {
    try {
      const ws = await getWorkspaceByIdCached(entry.workspaceId);
      if (!shouldAlert({ id: tabId }, ws, await getConfig())) return;
      await this.dispatchAlert({
        kind,
        tabId,
        workspace: ws,
        workspaceId: entry.workspaceId,
        tabName: entry.tabName,
        providerId: toAlertProvider(entry.agentProviderId),
        agentSessionId: entry.agentSessionId,
        lastUserMessage: entry.lastUserMessage,
      });
    } catch (err) {
      log.warn('Alert dispatch failed: %s', err);
    }
  }

  private async dispatchAlert(params: {
    kind: TAlertKind;
    tabId: string;
    workspace: IWorkspace | undefined;
    workspaceId: string;
    tabName: string;
    providerId: TAlertProviderId;
    agentSessionId?: string | null;
    lastUserMessage?: string | null;
    headline?: string | null;
    detail?: string | null;
  }): Promise<void> {
    const draft = alertFor({
      kind: params.kind,
      tabId: params.tabId,
      workspaceId: params.workspaceId,
      workspaceName: params.workspace?.name ?? '',
      tabName: params.tabName,
      providerId: params.providerId,
      isOrchestrator: isOrchestratorTab({ id: params.tabId }, params.workspace),
      at: Date.now(),
      lastUserMessage: params.lastUserMessage,
      headline: params.headline,
      detail: params.detail,
    });
    await getNotificationDispatcher().dispatch(draft, {
      agentSessionId: params.agentSessionId ?? null,
      workspaceDir: params.workspace?.directories[0] ?? null,
    });
  }

  /**
   * Feed one mutating tool call to the signal engine.
   *
   * Runs on every Edit/Write/Bash a worker makes, so it must stay allocation-
   * light and must never await the layout on the hot path — scope and cwd come
   * from a short-lived cache instead.
   */
  handleToolActivity(providerId: string, tmuxSession: string, activity: IToolActivity): void {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) return;
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    const expectedProvider = getProviderByPanelType(entry.panelType);
    if (expectedProvider && expectedProvider.id !== providerId) return;

    const meta = this.tabScopeCache.get(tabId);
    if (!meta || Date.now() - meta.at > TAB_SCOPE_TTL_MS) {
      // Refresh out of band; this call uses whatever is cached, including
      // nothing on the very first tool call of a tab.
      this.refreshTabScope(tabId, entry).catch(() => {});
    }
    getSignalEngine().record(tabId, activity, meta?.scope, meta?.cwd);
  }

  private async refreshTabScope(tabId: string, entry: ITabStatusEntry): Promise<void> {
    const layout = await readLayoutFile(resolveLayoutFile(entry.workspaceId));
    if (!layout) return;
    const tab = collectAllTabs(layout.root).find((t) => t.id === tabId);
    this.tabScopeCache.set(tabId, { scope: tab?.scope, cwd: tab?.cwd, at: Date.now() });
  }

  private deliverSignal(signal: IAgentSignal): void {
    const entry = this.tabs.get(signal.tabId);
    if (!entry) return;
    const evidence = signal.evidence.length ? ` (${signal.evidence.join(', ')})` : '';
    this.nudgeOrchestrator(signal.tabId, entry, signal.kind, `${signal.detail}${evidence}`).catch((err) => {
      log.warn(`signal nudge failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private async nudgeOrchestrator(tabId: string, entry: ITabStatusEntry, kind: TOrchestrationNudgeKind, detail?: string): Promise<void> {
    if (!isAgentPanelType(entry.panelType)) return;
    const ws = await getWorkspaceByIdCached(entry.workspaceId);
    const orch = ws?.orchestration;
    if (!ws || !orch?.enabled || !orch.orchestratorTabId || orch.orchestratorTabId === tabId) return;

    const now = Date.now();
    const last = this.lastNudgeByTab.get(tabId);
    if (last && last.kind === kind && now - last.at < NUDGE_DEBOUNCE_MS) return;
    this.lastNudgeByTab.set(tabId, { kind, at: now });

    const message = buildNudgeMessage(kind, tabId, entry.tabName, ws.id, detail);
    const target = this.tabs.get(orch.orchestratorTabId);
    let delivered = false;
    if (target && await hasSession(target.tmuxSession)) {
      try {
        await sendBracketedPaste(target.tmuxSession, message);
        delivered = true;
      } catch (err) {
        log.warn(`orchestrator nudge delivery failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    const nudge: IOrchestrationNudge = {
      id: nanoid(8),
      workspaceId: ws.id,
      tabId,
      tabName: entry.tabName,
      kind,
      message,
      at: now,
      delivered,
    };
    this.orchestrationNudges.push(nudge);
    if (this.orchestrationNudges.length > MAX_NUDGE_HISTORY) {
      this.orchestrationNudges.splice(0, this.orchestrationNudges.length - MAX_NUDGE_HISTORY);
    }
    this.broadcast({ type: 'orchestration:nudge', nudge });
    log.info({ tabId, kind, delivered }, 'orchestrator nudge');
  }

  getOrchestrationNudges(workspaceId: string): IOrchestrationNudge[] {
    return this.orchestrationNudges.filter((n) => n.workspaceId === workspaceId);
  }

  async reportStandup(standup: IWorkspaceStandup): Promise<void> {
    const current = this.standups.get(standup.workspaceId);
    if (current && current.at > standup.at) return;
    this.standups.set(standup.workspaceId, standup);
    await addStandup(standup).catch((err) => {
      log.warn(`standup persist failed: ${err instanceof Error ? err.message : err}`);
    });
    this.broadcast({ type: 'standup:update', standup });
    log.info({ workspaceId: standup.workspaceId, state: standup.state, needsHuman: standup.needsHuman }, 'standup tick');

    void this.dispatchStandupAlert(standup).catch((err) => {
      log.warn(`standup alert failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  // A standup that needs a human is the orchestrator asking for you, so the
  // alert is addressed to the orchestrator tab rather than to whoever ticked.
  private async dispatchStandupAlert(standup: IWorkspaceStandup): Promise<void> {
    const ws = await getWorkspaceByIdCached(standup.workspaceId);
    const tabId = standupAlertTabId(standup, ws, await getConfig());
    if (!tabId) return;

    const entry = this.tabs.get(tabId);
    await this.dispatchAlert({
      kind: 'standup-needs-human',
      tabId,
      workspace: ws,
      workspaceId: standup.workspaceId,
      tabName: entry?.tabName ?? '',
      providerId: toAlertProvider(entry?.agentProviderId),
      agentSessionId: entry?.agentSessionId,
      headline: standup.headline,
    });
  }

  getStandupsForClient(): Record<string, IWorkspaceStandup> {
    return Object.fromEntries(this.standups);
  }

  queueKickoffPrompt(tabId: string, prompt: string): void {
    this.clearPendingKickoff(tabId);
    const timer = setTimeout(() => this.deliverKickoff(tabId), KICKOFF_FALLBACK_DELAY_MS);
    this.pendingKickoffs.set(tabId, { prompt, timer });
  }

  private clearPendingKickoff(tabId: string): void {
    const pending = this.pendingKickoffs.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingKickoffs.delete(tabId);
  }

  // TUI가 뜬 직후 붙여넣으면 입력이 유실될 수 있어 800ms 정착 후 전송한다.
  private deliverKickoff(tabId: string): void {
    const pending = this.pendingKickoffs.get(tabId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingKickoffs.delete(tabId);
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    setTimeout(() => {
      sendBracketedPaste(entry.tmuxSession, pending.prompt).catch((err) => {
        log.warn(`kickoff prompt delivery failed: ${err instanceof Error ? err.message : err}`);
      });
    }, 800);
  }

  private async hasRecentJsonlActivity(entry: ITabStatusEntry, now: number): Promise<boolean> {
    const handle = this.runtimeHandle(entry);
    if (!handle) return false;
    const provider = entry.agentProviderId ? getProvider(entry.agentProviderId) : getProviderByPanelType(entry.panelType);
    if (!provider) return false;
    try {
      const snapshot = await provider.readRuntimeSnapshot(handle);
      return snapshot.lastEntryTs !== null && now - snapshot.lastEntryTs < BUSY_STUCK_MS;
    } catch {
      return false;
    }
  }

  private runtimeHandle(entry: ITabStatusEntry): string | null {
    return runtimeHandleFor(
      runtimeProviderId(entry.agentProviderId, entry.panelType),
      { jsonlPath: entry.jsonlPath, sessionId: entry.agentSessionId },
    );
  }

  private async saveSessionHistory(tabId: string, entry: ITabStatusEntry, prevBusySince: number | null | undefined, cancelled: boolean): Promise<void> {
    if (!entry.lastUserMessage) return;

    const provider = entry.agentProviderId ? getProvider(entry.agentProviderId) : getProviderByPanelType(entry.panelType);
    const handle = this.runtimeHandle(entry);
    const stats = handle && provider
      ? await provider.readSessionHistoryStats(handle)
      : null;
    const { workspaces } = await getWorkspaces();
    const ws = workspaces.find((w) => w.id === entry.workspaceId);
    const now = Date.now();
    const startedAt = stats?.firstUserTs ?? prevBusySince ?? now;
    const completedAt = cancelled ? now : (stats?.lastAssistantTs ?? now);
    const duration = cancelled
      ? completedAt - startedAt
      : (stats?.turnDurationMs ?? (completedAt - startedAt));

    const providerId = toSessionHistoryProvider(entry.agentProviderId);
    const historyEntry: ISessionHistoryEntry = {
      id: nanoid(),
      workspaceId: entry.workspaceId,
      workspaceName: ws?.name ?? entry.workspaceId,
      workspaceDir: ws?.directories[0] ?? null,
      tabId,
      providerId,
      agentSessionId: entry.agentSessionId ?? null,
      prompt: stats?.lastUserText ?? entry.lastUserMessage,
      result: stats?.lastAssistantText ?? null,
      startedAt,
      completedAt,
      duration,
      dismissedAt: completedAt,
      toolUsage: stats?.toolUsage ?? {},
      touchedFiles: stats?.touchedFiles ?? [],
      ...(cancelled ? { cancelled: true } : {}),
    };

    await addSessionHistoryEntry(historyEntry);
    this.broadcast({ type: 'session-history:update', entry: historyEntry });
  }

  dismissTab(tabId: string, exclude?: WebSocket): void {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.cliState !== 'ready-for-review') return;

    const dismissedAt = Date.now();
    this.applyCliState(tabId, entry, 'idle', { silent: true });
    entry.dismissedAt = dismissedAt;
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry, exclude);

    updateSessionHistoryDismissedAt(tabId, dismissedAt).then((updated) => {
      if (updated) this.broadcast({ type: 'session-history:update', entry: updated });
    }).catch((err) => {
      log.warn('Failed to update session history dismissedAt: %s', err);
    });
  }

  ackNotificationInput(tabId: string, seq: number): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    if (entry.cliState !== 'needs-input') return;
    if (entry.lastEvent?.name !== 'notification' || entry.lastEvent.seq !== seq) return;

    hookLog.debug({ tabId, seq }, 'ack: needs-input→busy');
    this.applyCliState(tabId, entry, 'busy');
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry);
  }

  // Codex의 SessionStart hook은 첫 사용자 메시지 후에야 발사된다(turn.rs:299).
  // 그 전엔 cliState가 'inactive'에 머물러 WebInputBar가 비활성화되므로
  // dead state. 3-layer 신호로 composer가 입력 받을 준비됐다고 확신될 때
  // 합성 session-start를 트리거해 idle로 진입시킨다.
  private async checkCodexTuiReady(
    entry: ITabStatusEntry,
    checkAgentRunning: () => Promise<boolean>,
  ): Promise<boolean> {
    if (!(await checkAgentRunning())) return false;

    const content = await capturePaneAtWidth(entry.tmuxSession, 80, 24).catch((err) => {
      log.warn('codex tui ready capture failed: %s', err);
      return null;
    });
    if (!content) return false;
    return isCodexTuiReadyContent(content);
  }

  async recoverUnknownIfPending(tabId: string): Promise<{ recovered: boolean; reason?: string }> {
    const entry = this.tabs.get(tabId);
    if (!entry) return { recovered: false, reason: 'no-entry' };
    if (entry.cliState !== 'unknown') return { recovered: false, reason: 'not-unknown' };

    const content = await capturePaneAtWidth(entry.tmuxSession, 120, 50).catch((err) => {
      log.warn('recoverUnknownIfPending capture failed: %s', err);
      return null;
    });
    if (!content) return { recovered: false, reason: 'capture-failed' };

    const { options } = parsePermissionOptions(content);
    if (options.length === 0) return { recovered: false, reason: 'no-options' };

    const now = Date.now();
    const seq = (entry.eventSeq ?? 0) + 1;
    entry.eventSeq = seq;
    entry.lastEvent = { name: 'notification', at: now, seq };

    hookLog.debug({ tabId, seq, options: options.length }, 'recover unknown→needs-input from pane capture');
    this.applyCliState(tabId, entry, 'needs-input', { silent: true });
    this.persistToLayout(entry);
    this.broadcastUpdate(tabId, entry);
    return { recovered: true };
  }

  private findTabIdBySession(tmuxSession: string): string | undefined {
    for (const [tabId, entry] of this.tabs) {
      if (entry.tmuxSession === tmuxSession) return tabId;
    }
    return undefined;
  }

  updateTabFromHook(tmuxSession: string, event: string, notificationType?: string): void {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) {
      hookLog.debug({ tmuxSession, event, notificationType }, 'no tabId for session');
      return;
    }
    const entry = this.tabs.get(tabId);
    if (!entry) {
      hookLog.debug({ tabId, event, notificationType }, 'no entry for tab');
      return;
    }

    if (event === 'pre-compact' || event === 'post-compact') {
      hookLog.debug({ tabId, event }, 'compact hook');
      this.setCompacting(tabId, entry, event === 'pre-compact' ? Date.now() : null);
      return;
    }

    if (event !== 'session-start' && event !== 'prompt-submit' && event !== 'notification' && event !== 'stop' && event !== 'interrupt') {
      hookLog.debug({ tabId, event, notificationType }, 'unknown event, ignoring');
      return;
    }
    const eventName = event as TEventName;

    if (eventName === 'notification' && notificationType && !INPUT_REQUESTING_NOTIFICATION_TYPES.has(notificationType)) {
      hookLog.debug({ tabId, event: eventName, notificationType }, 'non-input notification, skipping state transition');
      return;
    }

    const now = Date.now();
    const seq = (entry.eventSeq ?? 0) + 1;
    entry.eventSeq = seq;
    entry.lastEvent = { name: eventName, at: now, seq };
    if (eventName === 'session-start') entry.lastResumeOrStartedAt = now;
    this.broadcast({ type: 'status:hook-event', tabId, event: entry.lastEvent });

    const prevState = entry.cliState;
    const newState = deriveAgentCliState(entry.lastEvent, prevState);

    hookLog.debug(
      { tabId, event: eventName, notificationType, seq, prevState, newState, transition: prevState !== newState },
      `processed ${eventName}${notificationType ? `(${notificationType})` : ''} ${prevState}→${newState}`,
    );

    if (prevState !== newState) {
      this.applyCliState(tabId, entry, newState);
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
    }

    if ((newState === 'busy' || newState === 'needs-input') && !entry.jsonlPath) {
      this.resolveAndWatchJsonl(tabId, tmuxSession).catch(() => {});
    }

    const stopHandle = this.runtimeHandle(entry);
    if (eventName === 'stop' && stopHandle) {
      const refreshSnippet = (force = false) => {
        const provider = getProviderByPanelType(entry.panelType);
        if (!provider) return;
        provider.readRuntimeSnapshot(stopHandle, { force }).then(({ currentAction, lastAssistantSnippet, reset }) => {
          let updated = false;
          if (reset) {
            if (entry.currentAction !== null) { entry.currentAction = null; updated = true; }
            if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; updated = true; }
          } else {
            if (currentAction !== null && currentAction.summary !== entry.currentAction?.summary) {
              entry.currentAction = currentAction;
              updated = true;
            }
            if (lastAssistantSnippet !== null && entry.lastAssistantMessage !== lastAssistantSnippet) {
              entry.lastAssistantMessage = lastAssistantSnippet;
              updated = true;
            }
          }
          if (updated) this.broadcastUpdate(tabId, entry);
        }).catch(() => {});
      };
      refreshSnippet();
      setTimeout(() => {
        refreshSnippet(true);
      }, 500);
    }
  }

  handleProviderEvent(providerId: string, tmuxSession: string, event: TAgentWorkStateEvent): boolean {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) {
      hookLog.debug({ providerId, tmuxSession, event: event.kind }, 'no tabId for provider event');
      return false;
    }
    const entry = this.tabs.get(tabId);
    if (!entry) {
      hookLog.debug({ providerId, tabId, event: event.kind }, 'no entry for provider event tab');
      return false;
    }
    const expectedProvider = getProviderByPanelType(entry.panelType);
    if (expectedProvider && expectedProvider.id !== providerId) {
      hookLog.debug(
        { providerId, expectedProviderId: expectedProvider.id, tabId, event: event.kind },
        'provider event panel mismatch',
      );
      return false;
    }
    this.handleTabWorkStateEvent(tabId, event);
    return true;
  }

  applyAgentHookMeta(
    providerId: string,
    tmuxSession: string,
    meta: IAgentHookMetaPatch,
  ): { tabId: string; cliState: TCliState } | null {
    const tabId = this.findTabIdBySession(tmuxSession);
    if (!tabId) return null;
    const entry = this.tabs.get(tabId);
    if (!entry) return null;
    const expectedProvider = getProviderByPanelType(entry.panelType);
    if (expectedProvider && expectedProvider.id !== providerId) {
      hookLog.debug(
        { providerId, expectedProviderId: expectedProvider.id, tabId },
        'provider hook meta panel mismatch',
      );
      return null;
    }

    let changed = false;

    if (entry.agentProviderId !== providerId) {
      entry.agentProviderId = providerId;
      changed = true;
    }
    if (meta.sessionId !== undefined && entry.agentSessionId !== meta.sessionId) {
      entry.agentSessionId = meta.sessionId;
      changed = true;
    }
    if (meta.jsonlPath !== undefined && entry.jsonlPath !== meta.jsonlPath) {
      entry.jsonlPath = meta.jsonlPath;
      changed = true;
    }
    if (meta.clearMessages) {
      if (entry.agentSummary !== null) { entry.agentSummary = null; changed = true; }
      if (entry.lastUserMessage !== null) { entry.lastUserMessage = null; changed = true; }
      if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; changed = true; }
    }
    if (meta.lastUserMessage !== undefined && entry.lastUserMessage !== meta.lastUserMessage) {
      entry.lastUserMessage = meta.lastUserMessage;
      changed = true;
    }
    if (meta.agentSummary !== undefined && entry.agentSummary !== meta.agentSummary) {
      entry.agentSummary = meta.agentSummary;
      changed = true;
    }
    if (meta.permissionRequest !== undefined && entry.permissionRequest !== meta.permissionRequest) {
      entry.permissionRequest = meta.permissionRequest;
      changed = true;
    }

    if (changed) {
      const provider = expectedProvider ?? getProvider(providerId);
      if (provider) {
        updateTabAgentState(entry.tmuxSession, provider, {
          ...(meta.sessionId !== undefined ? { sessionId: meta.sessionId } : {}),
          ...(meta.jsonlPath !== undefined ? { jsonlPath: meta.jsonlPath } : {}),
          ...(meta.agentSummary !== undefined || meta.clearMessages
            ? { summary: meta.clearMessages ? null : meta.agentSummary ?? null }
            : {}),
          ...(meta.lastUserMessage !== undefined || meta.clearMessages
            ? { lastUserMessage: meta.clearMessages ? null : meta.lastUserMessage ?? null }
            : {}),
        }).catch(() => {});
      }
      this.persistToLayout(entry);
      this.broadcastUpdate(tabId, entry);
    }

    return { tabId, cliState: entry.cliState };
  }

  private setCompacting(tabId: string, entry: ITabStatusEntry, since: number | null): void {
    const existingTimer = this.compactStaleTimers.get(tabId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.compactStaleTimers.delete(tabId);
    }

    if ((entry.compactingSince ?? null) === since) return;
    entry.compactingSince = since;
    this.broadcastUpdate(tabId, entry);

    if (since !== null) {
      const timer = setTimeout(() => {
        this.compactStaleTimers.delete(tabId);
        const e = this.tabs.get(tabId);
        if (!e || e.compactingSince !== since) return;
        e.compactingSince = null;
        hookLog.debug({ tabId }, 'compact stale, auto-cleared');
        this.broadcastUpdate(tabId, e);
      }, COMPACT_STALE_MS);
      this.compactStaleTimers.set(tabId, timer);
    }
  }

  removeTab(tabId: string): void {
    const entry = this.tabs.get(tabId);
    if (entry && (entry.cliState === 'busy' || entry.cliState === 'needs-input') && entry.lastUserMessage) {
      this.saveSessionHistory(tabId, entry, entry.busySince, true).catch((err) => {
        log.warn('Failed to save cancelled session history: %s', err);
      });
    }
    this.stopJsonlWatch(tabId);
    const compactTimer = this.compactStaleTimers.get(tabId);
    if (compactTimer) {
      clearTimeout(compactTimer);
      this.compactStaleTimers.delete(tabId);
    }
    this.tabs.delete(tabId);
    this.broadcastRemove(tabId);
  }

  reconcileWorkspaceTabs(wsId: string, validTabIds: readonly string[]): void {
    const valid = new Set(validTabIds);
    for (const [tabId, entry] of this.tabs) {
      if (entry.workspaceId === wsId && !valid.has(tabId)) {
        this.removeTab(tabId);
      }
    }
  }

  removeWorkspaceTabs(wsId: string): void {
    for (const [tabId, entry] of this.tabs) {
      if (entry.workspaceId === wsId) {
        this.removeTab(tabId);
      }
    }
  }

  registerTab(tabId: string, entry: ITabStatusEntry): void {
    this.tabs.set(tabId, entry);
    this.broadcastUpdate(tabId, entry);
  }

  private handleTabWorkStateEvent(tabId: string, event: TAgentWorkStateEvent): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    switch (event.kind) {
      case 'session-start':
      case 'prompt-submit':
      case 'stop':
      case 'interrupt':
      case 'pre-compact':
      case 'post-compact':
        this.updateTabFromHook(entry.tmuxSession, event.kind);
        break;
      case 'notification':
        this.updateTabFromHook(entry.tmuxSession, 'notification', event.notificationType);
        break;
      case 'summary-update':
        if (entry.agentSummary !== event.summary) {
          entry.agentSummary = event.summary;
          this.broadcastUpdate(tabId, entry);
        }
        break;
      case 'last-user-message':
        if (entry.lastUserMessage !== event.message) {
          entry.lastUserMessage = event.message;
          this.broadcastUpdate(tabId, entry);
        }
        break;
    }
  }

  markAgentLaunch(tabId: string, options?: { resetAgentSession?: boolean }): void {
    const entry = this.tabs.get(tabId);
    if (!entry) return;
    entry.lastResumeOrStartedAt = Date.now();
    if (options?.resetAgentSession) {
      entry.agentSessionId = null;
      entry.jsonlPath = null;
      entry.agentSummary = null;
      entry.lastUserMessage = null;
      entry.lastAssistantMessage = null;
      entry.currentAction = null;
      entry.permissionRequest = null;
      const existingWatcher = this.jsonlWatchers.get(tabId);
      if (existingWatcher) {
        existingWatcher.watcher.close();
        if (existingWatcher.debounceTimer) clearTimeout(existingWatcher.debounceTimer);
        this.jsonlWatchers.delete(tabId);
      }
      this.persistToLayout(entry);
      const provider = getProviderByPanelType(entry.panelType);
      if (provider) {
        updateTabAgentState(entry.tmuxSession, provider, {
          sessionId: null,
          jsonlPath: null,
          summary: null,
          lastUserMessage: null,
        }).catch(() => {});
      }
      this.broadcastUpdate(tabId, entry);
    }
    for (const delay of LAUNCH_READY_POLL_DELAYS_MS) {
      setTimeout(() => {
        this.poll().catch((err) => {
          log.error({ err, tabId }, 'Launch readiness poll error');
        });
      }, delay);
    }
  }

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    if (this.lastRateLimits && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'rate-limits:update', data: this.lastRateLimits }));
    }
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
  }

  private persistToLayout(entry: ITabStatusEntry): void {
    updateTabCliStatus(entry.tmuxSession, entry.cliState, entry.dismissedAt).catch(() => {});
  }

  private broadcastUpdate(tabId: string, entry: ITabStatusEntry, exclude?: WebSocket): void {
    const msg: IStatusUpdateMessage = {
      type: 'status:update',
      tabId,
      cliState: entry.cliState,
      workspaceId: entry.workspaceId,
      tabName: entry.tabName,
      currentProcess: entry.currentProcess,
      paneTitle: entry.paneTitle,
      panelType: entry.panelType,
      terminalStatus: entry.terminalStatus,
      listeningPorts: entry.listeningPorts,
      agentProviderId: entry.agentProviderId,
      agentSummary: entry.agentSummary,
      lastUserMessage: entry.lastUserMessage,
      lastAssistantMessage: entry.lastAssistantMessage,
      currentAction: entry.currentAction,
      readyForReviewAt: entry.readyForReviewAt,
      busySince: entry.busySince,
      dismissedAt: entry.dismissedAt,
      agentSessionId: entry.agentSessionId,
      compactingSince: entry.compactingSince,
      permissionRequest: entry.permissionRequest,
      lastEvent: entry.lastEvent,
      eventSeq: entry.eventSeq,
    };
    this.broadcast(msg, exclude);
  }

  private broadcastRemove(tabId: string): void {
    const msg: IStatusUpdateMessage = {
      type: 'status:update',
      tabId,
      cliState: null,
      workspaceId: '',
      tabName: '',
    };
    this.broadcast(msg);
  }

  private static readonly BACKPRESSURE_LIMIT = 1024 * 1024;

  broadcast(event: object, exclude?: WebSocket): void {
    const msg = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws !== exclude && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < StatusManager.BACKPRESSURE_LIMIT) {
        ws.send(msg);
      }
    }
  }

  private async resolveAndWatchJsonl(tabId: string, tmuxSession: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry || entry.jsonlPath) return;

    let jsonlPath: string | null = null;

    const parsed = parseSessionName(tmuxSession);
    if (parsed) {
      const layout = await readLayoutFile(resolveLayoutFile(parsed.wsId));
      if (layout) {
        const tab = collectAllTabs(layout.root).find((t) => t.sessionName === tmuxSession);
        const tabProvider = getProviderByPanelType(tab?.panelType);
        const tabSessionId = tab && tabProvider ? tabProvider.readSessionId(tab) : null;
        if (tab && tabProvider && tabSessionId) {
          if (tabProvider.id === GROK_PROVIDER_ID) {
            jsonlPath = await resolveGrokJsonlPath(tabSessionId);
          } else if (tabProvider.id === CODEX_PROVIDER_ID) {
            jsonlPath = (await findCodexSessionById(tabSessionId))?.jsonlPath ?? null;
          } else {
            const cwd = await getSessionCwd(tmuxSession);
            if (cwd) {
              const candidate = `${cwdToProjectPath(cwd)}/${tabSessionId}.jsonl`;
              try {
                await fs.access(candidate);
                jsonlPath = candidate;
              } catch { /* noop */ }
            }
          }
        }

        if (tab?.lastUserMessage && entry.lastUserMessage !== tab.lastUserMessage) {
          entry.lastUserMessage = tab.lastUserMessage;
          this.broadcastUpdate(tabId, entry);
        }
      }
    }

    if (!jsonlPath) {
      const panePid = await getSessionPanePid(tmuxSession);
      if (panePid) {
        const { info } = await detectAnyActiveSession(panePid);
        jsonlPath = info.jsonlPath;
      }
    }

    if (!jsonlPath) return;

    entry.jsonlPath = jsonlPath;
    const provider = getProviderByPanelType(entry.panelType);
    if (provider) {
      entry.agentProviderId = provider.id;
      entry.agentSessionId = provider.sessionIdFromJsonlPath(jsonlPath) ?? entry.agentSessionId;
    }

    if ((entry.cliState === 'busy' || entry.cliState === 'needs-input') && !this.jsonlWatchers.has(tabId)) {
      this.startJsonlWatch(tabId, jsonlPath);
    }
  }

  private startJsonlWatch(tabId: string, jsonlPath: string): void {
    const existing = this.jsonlWatchers.get(tabId);
    if (existing?.jsonlPath === jsonlPath) return;
    if (existing) this.stopJsonlWatch(tabId);

    log.debug('startJsonlWatch tabId=%s path=%s', tabId, jsonlPath);
    try {
      const watcher = watch(jsonlPath, () => {
        const w = this.jsonlWatchers.get(tabId);
        if (!w) return;
        if (w.debounceTimer) clearTimeout(w.debounceTimer);
        w.debounceTimer = setTimeout(() => {
          this.onJsonlFileChange(tabId, jsonlPath).catch(() => {});
        }, JSONL_WATCH_DEBOUNCE_MS);
      });
      watcher.on('error', () => {
        this.stopJsonlWatch(tabId);
      });
      this.jsonlWatchers.set(tabId, { watcher, jsonlPath, debounceTimer: null });
    } catch {
      // file may not exist yet
    }
  }

  private stopJsonlWatch(tabId: string): void {
    const w = this.jsonlWatchers.get(tabId);
    if (!w) return;
    log.debug('stopJsonlWatch tabId=%s', tabId);
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    try { w.watcher.close(); } catch { /* noop */ }
    this.jsonlWatchers.delete(tabId);
  }

  private async onJsonlFileChange(tabId: string, jsonlPath: string): Promise<void> {
    const entry = this.tabs.get(tabId);
    if (!entry) {
      this.stopJsonlWatch(tabId);
      return;
    }
    const isActive = entry.cliState === 'busy' || entry.cliState === 'needs-input' || entry.cliState === 'unknown';
    if (!isActive && entry.cliState !== 'ready-for-review') {
      this.stopJsonlWatch(tabId);
      return;
    }

    const provider = getProviderByPanelType(entry.panelType);
    if (!provider) return;
    const { currentAction, lastAssistantSnippet, reset, interrupted, lastEntryTs } = await provider.readRuntimeSnapshot(jsonlPath);
    if (entry.agentProviderId === CODEX_PROVIDER_ID || entry.panelType === 'codex-cli') {
      cacheCodexRateLimitsFromJsonl(jsonlPath).catch(() => {});
    }

    if (
      interrupted
      && entry.cliState === 'busy'
      && lastEntryTs !== null
      && lastEntryTs > (entry.lastInterruptTs ?? 0)
      && lastEntryTs > (entry.lastEvent?.at ?? 0)
    ) {
      entry.lastInterruptTs = lastEntryTs;
      hookLog.debug({ tabId, lastEntryTs }, 'synthetic interrupt from JSONL');
      this.updateTabFromHook(entry.tmuxSession, 'interrupt');
    }

    let changed = false;

    if (reset) {
      if (entry.currentAction !== null) { entry.currentAction = null; changed = true; }
      if (entry.lastAssistantMessage !== null) { entry.lastAssistantMessage = null; changed = true; }
    } else {
      if (currentAction !== null && currentAction.summary !== entry.currentAction?.summary) {
        entry.currentAction = currentAction;
        changed = true;
      }
      if (lastAssistantSnippet !== null && entry.lastAssistantMessage !== lastAssistantSnippet) {
        entry.lastAssistantMessage = lastAssistantSnippet;
        changed = true;
      }
    }

    if (changed) {
      this.broadcastUpdate(tabId, entry);
    }
  }

  shutdown(): void {
    this.stopPolling();
    this.rateLimitsWatcher?.stop();
    for (const tabId of [...this.jsonlWatchers.keys()]) {
      this.stopJsonlWatch(tabId);
    }
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1001, 'Server shutting down');
      }
    }
    this.clients.clear();
  }

  notifyLastUserMessage(sessionName: string, message: string): void {
    const parsed = parseSessionName(sessionName);
    if (!parsed) return;
    const entry = this.tabs.get(parsed.tabId);
    if (!entry || entry.lastUserMessage === message) return;
    entry.lastUserMessage = message;
    this.broadcastUpdate(parsed.tabId, entry);
  }
}

export const getStatusManager = (): StatusManager => {
  if (!g.__ptStatusManager) {
    const manager = new StatusManager();
    g.__ptStatusManager = manager;
    const dispatcher = getNotificationDispatcher();
    dispatcher.register(createStatusSocketChannel((frame) => manager.broadcast(frame)));
    dispatcher.register(createWebPushChannel());
    setLayoutReconciler({
      reconcileWorkspaceTabs: (wsId, validTabIds) => manager.reconcileWorkspaceTabs(wsId, validTabIds),
      removeWorkspaceTabs: (wsId) => manager.removeWorkspaceTabs(wsId),
    });
  }
  return g.__ptStatusManager;
};
