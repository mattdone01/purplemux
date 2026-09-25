// Browser-safe orchestration helpers: kickoff template + watchdog nudge text.
// No node-only imports — the kickoff dialog resolves templates client-side and
// the StatusManager watchdog builds nudge messages server-side from the same code.
import type { TOrchestrationNudgeKind } from '@/types/status';
import { STANDUP_SCHEMA_HINT } from '@/lib/standup';

export const NUDGE_PREFIX = '[orchestrator-watchdog]';
export const NUDGE_DEBOUNCE_MS = 30_000;
export const MAX_NUDGE_HISTORY = 200;
export const KICKOFF_FALLBACK_DELAY_MS = 20_000;
export const ORCH_IDLE_HEARTBEAT_MS = 10 * 60 * 1000;
export const ORCH_MAX_HEARTBEATS = 3;

export const buildHeartbeatMessage = (idleMinutes: number, workspaceId: string): string =>
  `${NUDGE_PREFIX} heartbeat: you have been idle ~${idleMinutes} min with NO active workers and nothing pending that will wake you. Re-read your epic state and act on the next step now (dispatch workers, run the next phase, or report). Then post a standup tick (purplemux standup report -w ${workspaceId} --json '...') so the human can see where things stand without reading any pane. If the epic is finished or genuinely waiting on a human, post a final standup (state "done" or "awaiting-human", blockers naming the exact input you need) and then turn these heartbeats off yourself: purplemux orchestration off -w ${workspaceId}`;

export const parseOrchestrationPatch = (raw: unknown): Partial<import('@/types/terminal').IWorkspaceOrchestration> | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const patch: Partial<import('@/types/terminal').IWorkspaceOrchestration> = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return null;
    patch.enabled = body.enabled;
  }
  if (body.orchestratorTabId !== undefined) {
    if (body.orchestratorTabId !== null && typeof body.orchestratorTabId !== 'string') return null;
    patch.orchestratorTabId = body.orchestratorTabId;
  }
  if (body.kickoffTemplate !== undefined) {
    if (body.kickoffTemplate !== null && typeof body.kickoffTemplate !== 'string') return null;
    patch.kickoffTemplate = body.kickoffTemplate;
  }
  return patch;
};

export const DEFAULT_KICKOFF_TEMPLATE = `You are the ORCHESTRATOR for workspace "{{WORKSPACE_NAME}}". You delegate all implementation to worker agents in purplemux tabs (see the purplemux CLI section of your system prompt); you never implement work yourself.

## Spawning a worker
1. Assign the model and effort required for the task, then create a named tab with both pins: purplemux tab create -w {{WORKSPACE_ID}} -n story-NN -t claude-code -m <assigned-model> -r <assigned-effort> (or use -t codex-cli with its assigned model and effort). Every automated worker creation must include explicit -m and -r arguments; never inherit global defaults.
2. Send ONE self-contained brief: goal, exact file paths, acceptance criteria, verification commands, and this output protocol:
   "Work autonomously. Make reasonable assumptions and note them instead of asking, except for destructive or irreversible actions. When finished, end with a line 'DONE: <one-line summary>'. If truly blocked, end with 'BLOCKED: <single specific question>' and stop."
3. If the task runs long-lived background work (a drain, a batch load, a big build), arm TWO watchers AT DISPATCH: tell the worker to supervise its own job, AND register an independent liveness probe so the watchdog sees stalls even if the worker dies with its work:
   purplemux tab probe set -w {{WORKSPACE_ID}} <tabId> --cmd '<command printing seconds-since-last-progress>' --stale-after <secs>
   Register long-running background pids too (purplemux tab bg add -w {{WORKSPACE_ID}} <tabId> --pid <pid> --stderr <file> --exit-file <file>) so an exit reports completed, failed, or unknown status with a stderr tail when available. A quiet tab with dead work looks identical to a quiet healthy tab without these. Clear registrations when the job completes.

## Event loop (your whole job)
purplemux's built-in watchdog sends you '${NUDGE_PREFIX} ...' messages when a worker changes state. On each one:
- NEEDS INPUT: read the worker's pane (tab result), answer the question yourself from context via tab send. Escalate to the human only for real product/scope decisions, and keep other work moving.
- READY FOR REVIEW / turn ended: read the output, check for DONE:/BLOCKED:, run the verification commands, then accept or send concrete fix-up instructions. On accept: immediately assign the next task to that tab, or CLOSE it (purplemux tab close). Never leave a finished or abandoned worker tab open — the tab strip is the human's dashboard, and stale tabs hide real state.
- STALLED: read the pane. If genuinely working (long build/tests), wait. If hung, interrupt (tmux send-keys Escape) and re-prompt tighter; if that fails, close and respawn with an amended brief.
- BACKGROUND JOB COMPLETED: verify its artifacts and acceptance criteria, then accept the result or send concrete follow-up work. Do not restart successful work.
- BACKGROUND JOB FAILED: inspect its stderr and artifacts, diagnose, then restart only when retrying is justified and bounded. Repeated failures are systematic — stop restarting and escalate.
- BACKGROUND JOB EXITED (unknown status): inspect its artifacts and logs before deciding whether it succeeded or failed. Do not presume failure or restart blindly.
- STALLED (liveness probe) / LIVENESS PROBE FAILING: the tab's background work stopped progressing or cannot be observed even if the pane looks fine. Wake the worker (tab send) to diagnose it; if only a human can clear it (an expired credential, an interactive login), post a standup with needsHuman=true naming the exact command — that is what pushes an alert to the human's phone. Never quietly work around a dead credential.
- INACTIVE/DEAD: respawn the tab and re-issue the task, noting prior progress.
After handling every nudge, post a standup tick, then end your turn. The tick is the human's dashboard — it must answer "where are things at, are we progressing, any blockers, am I needed" at a glance:
purplemux standup report -w {{WORKSPACE_ID}} --json '${STANDUP_SCHEMA_HINT}'
One item per task with its current status; every blocker names the exact input that clears it; set needsHuman only when a human decision is genuinely required. Do not busy-wait; the watchdog will wake you. When the epic is FINISHED (or hard-blocked on a human): post a final standup (state "done", or "awaiting-human" with the blockers filled in), close remaining worker tabs, then run: purplemux orchestration off -w {{WORKSPACE_ID}} — this stops the idle heartbeats so you are not woken all night for nothing.

Mission Control is the durable decision record. At kickoff/resume and on ordinary turns, read outstanding answers and human-inbox policy guidance with purplemux mission answers -w {{WORKSPACE_ID}}. Acknowledge each exact answer ID with the generation, revision, and event ID supplied by its delivery notice before applying it, then explicitly resolve the attention item after the decision is applied. Workers route blockers to you; ordinary attention events create durable workspace candidates. Use existing instructions, authority, evidence, and delegated handling first. Routine setup, coordination, already-granted permissions, and parked-work choices are not human questions merely because a worker stopped. Only the remaining human-exclusive decision, approval, information, or external action receives an explicit human review from the configured orchestrator. Record workspace handling with a none review or cancel an issue handled elsewhere. Reuse stable item IDs and report transitions, not repeated unchanged issues. Emit stable Mission Control events when the run starts/resumes, meaningful progress changes, an attention item opens/changes, an answer is applied, or the run finishes. Do not turn standup blockers or historical transcript questions into confirmed decisions. Completion requires an explicit run.finished event — silence, an idle tab, or a "done" standup alone does not complete a run.

## Rules
- Max {{MAX_WORKERS}} concurrent workers. One task per worker tab.
- Never assume a worker's state — capture its pane before acting.

## The work
{{TASK}}

Begin: break the work down, then spawn workers for the first tasks.`;

export interface IKickoffTemplateVars {
  workspaceId: string;
  workspaceName: string;
  task?: string;
  maxWorkers?: number;
}

export const resolveKickoffTemplate = (template: string, vars: IKickoffTemplateVars): string =>
  template
    .replaceAll('{{WORKSPACE_ID}}', vars.workspaceId)
    .replaceAll('{{WORKSPACE_NAME}}', vars.workspaceName)
    .replaceAll('{{MAX_WORKERS}}', String(vars.maxWorkers ?? 3))
    .replaceAll('{{TASK}}', vars.task ?? '(described in the next message)');

export const buildNudgeMessage = (
  kind: TOrchestrationNudgeKind,
  tabId: string,
  tabName: string,
  workspaceId: string,
  detail?: string,
): string => {
  const who = `worker ${tabId} (${tabName || 'unnamed'})`;
  const capture = `Read it with: purplemux tab result -w ${workspaceId} ${tabId}`;
  switch (kind) {
    // Signal nudges arrive DURING a turn, not after it. The worker is still
    // running, so correcting it now is what saves the wasted work.
    case 'off-scope':
      return `${NUDGE_PREFIX} ${who} is WORKING OFF-SCOPE: ${detail ?? 'edits fall outside its declared scope'}. It is still running — decide now: send a correction with tab send, or interrupt it. Waiting for the turn to end wastes the rest of it.`;
    case 'thrash':
      return `${NUDGE_PREFIX} ${who} is THRASHING: ${detail ?? 'the same command keeps failing'}. It is still running — send a different approach with tab send, or interrupt it.`;
    case 'needs-input':
      return `${NUDGE_PREFIX} ${who} NEEDS INPUT. ${capture} — then answer via tab send.`;
    case 'ready-for-review':
      return `${NUDGE_PREFIX} ${who} is READY FOR REVIEW. ${capture} — verify, then accept or send follow-up work.`;
    case 'turn-ended':
      return `${NUDGE_PREFIX} ${who} finished its turn. ${capture} — verify, then accept or send follow-up work.`;
    case 'inactive':
      return `${NUDGE_PREFIX} ${who} is INACTIVE (agent process gone). Respawn the tab or mark its task blocked.`;
    case 'stuck':
      return `${NUDGE_PREFIX} ${who} has been busy with no activity for a long time — possibly stalled. ${capture} — decide: keep waiting, interrupt and re-prompt, or respawn.`;
    // Liveness nudges come from registered probes/pids, not tab state. The tab
    // can look perfectly healthy while its background work is dead — that
    // exact gap once cost 7 silent hours.
    case 'stalled':
      return `${NUDGE_PREFIX} ${who} work is STALLED: ${detail ?? 'a registered liveness probe reports stale progress'}. The tab may look healthy — probes watch the work, not the pane. ${capture} — check the background job, restart it or re-brief the worker, and escalate if deaths repeat.`;
    case 'probe-failed':
      return `${NUDGE_PREFIX} ${who} LIVENESS PROBE FAILING: ${detail ?? 'the registered probe command keeps erroring'}. A failing probe is not a green light — until it runs, nobody is watching this work. Fix the probe or the environment it needs. ${capture}`;
    case 'bg-completed':
      return `${NUDGE_PREFIX} ${who} BACKGROUND JOB COMPLETED: ${detail ?? 'a registered background pid exited successfully'}. ${capture} — verify its artifacts and acceptance criteria, then accept the result or send concrete follow-up work.`;
    case 'bg-failed':
      return `${NUDGE_PREFIX} ${who} BACKGROUND JOB FAILED: ${detail ?? 'a registered background pid exited nonzero'}. ${capture} — inspect stderr and artifacts, diagnose, then restart only when a bounded retry is justified. Repeated failures are systematic — stop restart-looping and escalate.`;
    case 'bg-exited-unknown':
      return `${NUDGE_PREFIX} ${who} BACKGROUND JOB EXITED with unknown status: ${detail ?? 'a registered background pid exited without a valid exit code'}. ${capture} — Inspect its artifacts and logs before deciding whether it succeeded or failed. Do not presume failure or restart blindly.`;
    case 'bg-died':
      return `${NUDGE_PREFIX} ${who} BACKGROUND JOB EXITED: ${detail ?? 'a legacy background-job notification did not record a reliable outcome'}. ${capture} — Inspect its artifacts and logs before deciding whether it succeeded or failed. Do not restart blindly.`;
    case 'model-drift':
      return `${NUDGE_PREFIX} ${who} MODEL POLICY MISMATCH: ${detail ?? 'the worker model or settings do not match its assignment'}. Automated dispatch is held. Inspect recorded model/settings and restore the assigned model before resuming; do not restart a running task blindly.`;
    case 'heartbeat':
      return buildHeartbeatMessage(0, workspaceId);
  }
};

export const nudgeKindForTransition = (prevState: string | undefined, newState: string, silent: boolean): TOrchestrationNudgeKind | null => {
  if (newState === 'inactive') return prevState && prevState !== 'unknown' ? 'inactive' : null;
  if (silent) return null;
  if (newState === 'needs-input') return 'needs-input';
  if (newState === 'ready-for-review') return 'ready-for-review';
  if (newState === 'idle' && prevState === 'busy') return 'turn-ended';
  return null;
};
