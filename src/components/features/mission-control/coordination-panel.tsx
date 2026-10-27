import { Component, useState, type ReactNode } from 'react';
import { RotateCcw, Send, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LeaseBreakDialog, OwnerNoteDialog, toastOutcome } from '@/components/features/mission-control/coordination-actions';
import { FleetStatusView, type IFleetFilter } from '@/components/features/mission-control/fleet-status-panel';
import useCoordination from '@/hooks/use-coordination';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { hostWarnings } from '@/lib/host-warnings';
import { humanRetryRefusal, postHumanAction } from '@/lib/human-actions';
import { cn } from '@/lib/utils';
import type { ICoordinationSnapshot, IDeployRow, TGrantsSection, THostSignals, TSection } from '@/types/coordination';
import type { IInboxItem } from '@/types/inbox';
import type { ILeaseView } from '@/types/lease';

// Mission Control coordination panel (story 20): leases, open notes, watches,
// grants, held deliveries, host pressure and deploy announcements. A stale
// holder must never block the fleet silently, and a full disk must show before
// it bites. The human actions (ADR-0029 §6-§8) sit on the coordination rows
// only; the fleet status view stays read-only (ADR-0023).

const HOLDER_LABEL: Record<string, string> = { live: 'live', 'agent-gone': 'agent gone', closed: 'closed', admin: 'admin' };
const NOTE_LABEL: Record<string, string> = { queued: 'queued', pending: 'pending', held: 'held', delivered: 'delivered', undeliverable: 'undeliverable' };
const OWNER_LABEL: Record<string, string> = { live: 'live', closed: 'owner closed', unknown: 'owner unknown' };
const WATCH_KIND_LABEL: Record<string, string> = { pr: 'PR', ref: 'ref', lease: 'lease' };
const WATCH_UNTIL_LABEL: Record<string, string> = {
  merged: 'merged', closed: 'closed', 'head-moved': 'head moved', 'checks-settled': 'checks settled', moved: 'moved', free: 'free',
};
const INBOX_LABEL: Record<string, string> = { note: 'note', watch: 'watch', deploy: 'deploy notice', mission: 'Mission Control', resume: 'resume' };
// The leading token of a held delivery's reason (inbox-dispatcher, composer-readiness, inbox-store refusals).
const HELD_LABEL: Record<string, string> = {
  'target-not-agent': 'target is not an agent tab',
  'stranded-in-composer': 'stranded in the composer',
  'transport-uncertain': 'delivery uncertain',
  'target-unresolved': 'target not found',
  'target-changed': 'target changed',
  'session-not-running': 'session not running',
  policy: 'refused by policy',
  'usage-limit-halt': 'usage limit reached',
  'dispatch-error': 'dispatch error',
  'status-unavailable': 'status unavailable',
  'native-prompt-active': 'prompt open',
  'interactive-prompt-active': 'prompt open',
  'composer-not-ready': 'composer not ready',
  'composer-unreadable': 'composer unreadable',
  'composer-not-empty': 'composer not empty',
  // inbox-store: a notice that expired with no refusal at all.
  'never ready': 'target never ready',
  // inbox-dispatcher preflight (story 12): no owner listening yet, or the owner's check threw.
  'preflight-unregistered': 'owner not ready',
  'preflight-error': 'owner check failed',
};

/** A served token through its label map: an unmapped one reads "other", never the raw token. */
const label = (map: Record<string, string>, token: string): string => (Object.hasOwn(map, token) ? map[token] : 'other');

/** A held reason reads as its label plus the served detail (`: <message>`, `(N refusals)`); never the bare token. */
export const heldReasonLabel = (reason: string | null): string => {
  if (!reason) return 'held';
  // The token is the text before the first ':' or ' (' ("never ready" has a space).
  const match = /^([a-z][a-z -]*?)((?::| \()[\s\S]*)?$/.exec(reason);
  if (!match) return `other: ${reason}`;
  const rest = match[2] ?? '';
  const detail = rest.startsWith(':') ? `: ${rest.slice(1)}` : rest;
  return `${label(HELD_LABEL, match[1])}${detail}`;
};

/** An epoch-ms stamp as ISO text; a value `Date` cannot represent reads "—", never a render crash. */
export const formatStamp = (ms: number): string => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString();
};

export const formatAge = (seconds: number | null | undefined): string => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};

export const formatBytes = (bytes: number): string => {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
};

const GRANT_REFUSAL_LABEL: Record<string, string> = {
  drive: 'Read grants are not honoured: grants.json cannot be read',
  owner: 'Owner sessions are not honoured: owner-grants.json cannot be read',
};

/** One sentence per grant file the server could not read (ADR-0029 §1), with the served reason. */
export const grantRefusals = (section: TGrantsSection): string[] => (section.ok
  ? (section.refused ?? []).map((r) => `${Object.hasOwn(GRANT_REFUSAL_LABEL, r.capability) ? GRANT_REFUSAL_LABEL[r.capability] : 'A grant file cannot be read'} — ${r.error}`)
  : []);

const WARN = 'text-ui-amber';

const DEPLOY_PHASE_LABEL: Record<string, string> = { pending: 'restart in', past: 'restarted' };

/** "restart in 4m" / "restarted 2h ago"; an unknown phase reads its time only. */
export const deployWhen = (row: Pick<IDeployRow, 'phase' | 'restartAt'>, now: number): string => {
  const seconds = Math.abs(row.restartAt - now) / 1000;
  if (!Object.hasOwn(DEPLOY_PHASE_LABEL, row.phase)) return `restart at ${formatStamp(row.restartAt)}`;
  return row.phase === 'pending' ? `${DEPLOY_PHASE_LABEL.pending} ${formatAge(seconds)}` : `${DEPLOY_PHASE_LABEL.past} ${formatAge(seconds)} ago`;
};

/** Who announced it: the admin token or a tab; never a bare id pair with a missing half. */
export const deployBy = (by: IDeployRow['by']): string =>
  (by.admin ? 'admin' : `${by.workspaceId ?? '—'}/${by.tabId ?? '—'}`);

/**
 * Delivered of total, then any notice still waiting or stopped, then the notices the inbox no longer
 * has (`deploy status` reads them `pruned`): served in `total` only, so named here, never left silent.
 */
export const deployRecipients = (r: IDeployRow['recipients']): string => {
  if (r.total === 0) return 'no recipients';
  const untracked = r.total - r.delivered - r.queued - r.held - r.dropped;
  const rest = ([['queued', r.queued], ['held', r.held], ['dropped', r.dropped], ['no longer tracked', untracked]] as const)
    .filter(([, n]) => n > 0).map(([word, n]) => `${n} ${word}`);
  return [`${r.delivered}/${r.total} delivered`, ...rest].join(' · ');
};

/** The actions the container wires; without them the rows render read-only. */
export interface ICoordinationActions {
  onRetry: (item: IInboxItem) => void;
  onBreak: (lease: ILeaseView) => void;
  onSendNote: () => void;
  /** Held notices whose retry is in flight: their button is disabled. */
  busy: ReadonlySet<string>;
}

const Section = <T,>({ title, section, empty, render, refusals = [] }: {
  title: string;
  section: TSection<T>;
  empty: string;
  render: (item: T, i: number) => ReactNode;
  /** Parts of the section the server could not read: named, and the section is then never "empty". */
  refusals?: string[];
}) => (
  <div className="min-w-0 space-y-1.5" data-section={title}>
    <h3 className="text-xs font-semibold">
      {title}
      {section.ok && <span className="ml-1.5 tabular-nums text-muted-foreground">{section.items.length}</span>}
    </h3>
    {refusals.map((text) => <p key={text} className="text-xs text-destructive" data-state="partial">{text}</p>)}
    {!section.ok ? (
      <p className="text-xs text-destructive" data-state="error">Could not read: {section.error}</p>
    ) : section.items.length === 0 ? (
      refusals.length === 0 && <p className="text-xs text-muted-foreground" data-state="empty">{empty}</p>
    ) : (
      <ul className="space-y-1 text-xs" data-state="populated">{section.items.map(render)}</ul>
    )}
  </div>
);

const SignalsView = ({ signals, now }: { signals: THostSignals; now: number }) => {
  if (signals.state === 'not-configured') return <p className="text-xs text-muted-foreground" data-signals="not-configured">Host signals: not configured</p>;
  if (signals.state === 'pending') return <p className="text-xs text-muted-foreground" data-signals="pending">Host signals: waiting for the first run</p>;
  const stamp = `run ${formatAge((now - signals.ranAt) / 1000)} ago${signals.stale ? ' (stale)' : ''}`;
  if (signals.state === 'error') {
    return <p className="text-xs text-destructive" data-signals="error">Host signals failed: {signals.error} · {stamp}</p>;
  }
  const v = signals.value;
  const worktrees = v.worktrees.reduce((sum, w) => sum + w.count, 0);
  return (
    <div className={cn('text-xs', signals.stale && 'text-muted-foreground')} data-signals="ok">
      Host signals ({stamp}; stamped {formatStamp(v.stampedAt)}): gate slots {v.gateSlots.held}/{v.gateSlots.total} held ·{' '}
      {worktrees} worktrees ({v.worktrees.map((w) => `${w.repo} ${w.count}`).join(', ') || 'none'}) · /tmp inodes {v.tmpInodesPct}%
    </div>
  );
};

export const CoordinationPanelView = ({ snapshot, error, loading, actions }: {
  snapshot: ICoordinationSnapshot | null;
  error: string | null;
  loading: boolean;
  actions?: ICoordinationActions;
}) => {
  if (!snapshot) {
    return (
      <Card className="border-foreground/10 shadow-none">
        <CardContent className="p-4 text-xs">
          {error ? <p className="text-destructive" data-state="error">Coordination unavailable: {error}</p> : <p className="text-muted-foreground">{loading ? 'Loading coordination…' : '—'}</p>}
        </CardContent>
      </Card>
    );
  }
  const now = snapshot.at;
  const host = snapshot.host;
  const warn = hostWarnings(host);
  return (
    <Card className="border-foreground/10 shadow-none" data-coordination-panel="">
      <CardContent className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
        {error && <p className="text-xs text-destructive sm:col-span-2" data-state="refresh-error">Last refresh failed: {error}</p>}
        {actions && (
          <div className="flex justify-end sm:col-span-2">
            <Button type="button" size="xs" variant="outline" onClick={actions.onSendNote} data-action="send-note">
              <Send />Send note as owner
            </Button>
          </div>
        )}
        <Section title="Leases" section={snapshot.leases} empty="No leases" render={(l) => {
          const stale = l.holderState === 'agent-gone' || l.holderState === 'closed';
          return (
            <li key={l.name} className="flex min-w-0 justify-between gap-2" data-lease={l.name} data-holder-state={l.holderState}>
              <span className="truncate font-mono">{l.name}</span>
              <span className="shrink-0 text-muted-foreground">
                {l.holder.admin ? 'admin' : `${l.holder.workspaceName ?? l.holder.workspaceId ?? '—'}/${l.holder.tabName ?? l.holder.tabId ?? '—'}`}
                {' · '}{formatAge(l.ageSeconds)}{' · '}{l.expiresInSeconds === null ? 'no expiry' : `expires ${formatAge(l.expiresInSeconds)}`}{' · '}
                <span className={cn(stale && WARN)}>{label(HOLDER_LABEL, l.holderState)}</span>
                {actions && (
                  <Button type="button" size="xs" variant="ghost" className="ml-1"
                    onClick={() => actions.onBreak(l)} data-action="break" aria-label={`Break lease ${l.name}`}>
                    <Unlock />Break…
                  </Button>
                )}
              </span>
            </li>
          );
        }} />
        <Section title="Open notes" section={snapshot.notes} empty="No open notes" render={(n) => (
          <li key={n.id} className="flex min-w-0 justify-between gap-2" data-note={n.id}>
            <span className="truncate">{n.subject}</span>
            <span className={cn('shrink-0 text-muted-foreground', n.state === 'undeliverable' && WARN)}>
              {label(NOTE_LABEL, n.state)} · {formatAge(n.ageSeconds)}
            </span>
          </li>
        )} />
        <Section title="Watches" section={snapshot.watches} empty="No watches" render={(w) => (
          <li key={w.id} className="flex min-w-0 justify-between gap-2" data-watch={w.id}>
            <span className="truncate"><span className="font-mono">{w.target}</span> ({label(WATCH_KIND_LABEL, w.kind)}) until {label(WATCH_UNTIL_LABEL, w.until)}</span>
            <span className={cn('shrink-0 text-muted-foreground', w.owner === 'closed' && WARN)}>
              {w.workspaceId}/{w.tabId} · {label(OWNER_LABEL, w.owner)} · {formatAge(w.ageSeconds)}
            </span>
          </li>
        )} />
        <Section title="Grants" section={snapshot.grants} empty="No active grants" refusals={grantRefusals(snapshot.grants)} render={(g) => (
          <li key={g.id} className="flex min-w-0 justify-between gap-2" data-grant={g.id} data-grant-capability={g.capability}>
            <span className="truncate">{g.grantee.workspaceId}/{g.grantee.tabId} {g.capability === 'owner' ? 'owner session — reads every workspace' : `reads ${g.workspaces.join(', ')}`}</span>
            <span className="shrink-0 text-muted-foreground">until {new Date(g.expiresAt).toLocaleString()}</span>
          </li>
        )} />
        <Section title="Held deliveries" section={snapshot.inboxHeld} empty="No held deliveries" render={(i) => (
          <li key={i.id} className="flex min-w-0 justify-between gap-2" data-held={i.id}>
            <span className="truncate">{label(INBOX_LABEL, i.kind)} → {i.targetWorkspaceId}/{i.targetTabId}</span>
            <span className="shrink-0">
              <span className={WARN}>{heldReasonLabel(i.heldReason)}</span>
              {actions && humanRetryRefusal(i) === null && (
                <Button type="button" size="xs" variant="ghost" className="ml-1" disabled={actions.busy.has(i.id)}
                  onClick={() => actions.onRetry(i)} data-action="retry" aria-label={`Retry ${label(INBOX_LABEL, i.kind)}`}>
                  <RotateCcw />Retry
                </Button>
              )}
            </span>
          </li>
        )} />
        <Section title="Orchestrator coverage" section={snapshot.orchestrators} empty="Every unfinished workspace has a usable orchestrator" render={(issue) => (
          <li
            key={issue.workspaceId}
            className="min-w-0 text-xs"
            data-orchestrator-coverage={issue.workspaceId}
            data-state={issue.state}
          >
            <span className={cn('font-medium', issue.state === 'missing' ? 'text-ui-red' : WARN)}>{issue.workspaceName}</span>
            <span className="text-muted-foreground"> · {issue.reason}</span>
            {issue.evidence.length > 0 && (
              <span className="block break-words text-muted-foreground">Evidence: {issue.evidence.join('; ')}</span>
            )}
          </li>
        )} />
        {snapshot.deploys ? (
          <Section title="Deploys" section={snapshot.deploys} empty="No deploy announced in the last 24 h" render={(d) => (
            <li key={d.id} className="min-w-0" data-deploy={d.id} data-phase={d.phase}>
              <span className="flex min-w-0 justify-between gap-2">
                <span className="truncate">{d.reason}</span>
                <span className={cn('shrink-0', d.phase === 'pending' ? WARN : 'text-muted-foreground')}>{deployWhen(d, now)}</span>
              </span>
              <span className="block text-muted-foreground">by {deployBy(d.by)} · {deployRecipients(d.recipients)}</span>
            </li>
          )} />
        ) : (
          <div className="min-w-0 space-y-1.5" data-section="Deploys">
            <h3 className="text-xs font-semibold">Deploys</h3>
            <p className="text-xs text-muted-foreground" data-state="unsupported">Not available from this server version</p>
          </div>
        )}
        <div className="min-w-0 space-y-1.5" data-section="Host">
          <h3 className="text-xs font-semibold">Host</h3>
          {!host.available ? (
            <p className="text-xs text-muted-foreground" data-state="unavailable">{host.reason}</p>
          ) : (
            <ul className="space-y-1 text-xs" data-state="populated">
              {host.disks.map((d) => (
                <li key={d.path} data-disk={d.path} data-warn={warn.disks.has(d.path) || warn.inodes.has(d.path) ? 'true' : undefined}>
                  <span className="font-mono">{d.path}</span>{' '}
                  <span className={cn(warn.disks.has(d.path) && WARN)}>disk {d.usedPct === null ? '—' : `${d.usedPct}%`} ({formatBytes(d.freeBytes)} free)</span>
                  {d.inodesUsedPct !== null && <span className={cn(warn.inodes.has(d.path) && WARN)}> · inodes {d.inodesUsedPct}%</span>}
                </li>
              ))}
              <li data-tmp-inodes="" data-warn={warn.tmpInodes ? 'true' : undefined}>
                <span className="font-mono">/tmp</span>{' '}
                <span className={cn(warn.tmpInodes && WARN)}>inodes {host.tmpInodesUsedPct === null ? '—' : `${host.tmpInodesUsedPct}%`}</span>
              </li>
              <li>load {host.loadAverage.map((l) => l.toFixed(1)).join(' / ')} · memory available {formatBytes(host.memAvailableBytes)}</li>
            </ul>
          )}
          <SignalsView signals={snapshot.signals} now={now} />
        </div>
      </CardContent>
    </Card>
  );
};

/** A render failure blanks this panel only, never the Mission Control page (which has no boundary of its own). */
export class CoordinationErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown) {
    console.error(`[${(this.props.label ?? 'Coordination panel').toLowerCase()}] render failed:`, err);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <Card className="border-foreground/10 shadow-none">
        <CardContent className="space-y-2 p-4 text-xs">
          <p className="text-destructive" data-state="render-error">{this.props.label ?? 'Coordination panel'} failed to render: {this.state.error}</p>
          <button type="button" className="underline" onClick={() => this.setState({ error: null })}>Retry</button>
        </CardContent>
      </Card>
    );
  }
}

const CoordinationPanel = () => {
  const { snapshot, error, loading, refresh } = useCoordination();
  const [fleetFilter, setFleetFilter] = useState<IFleetFilter>({ showAll: false, workspace: null });
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [noteOpen, setNoteOpen] = useState(false);
  const [breaking, setBreaking] = useState<ILeaseView | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const retry = async (item: IInboxItem) => {
    setBusy((b) => new Set(b).add(item.id));
    const outcome = await postHumanAction<{ item: IInboxItem }>(`/api/mission-control/inbox/${encodeURIComponent(item.id)}/retry`);
    setBusy((b) => { const next = new Set(b); next.delete(item.id); return next; });
    toastOutcome(outcome, () => 'Notice re-queued; the inbox types it when the tab is ready');
    void refresh();
  };
  const actions: ICoordinationActions = {
    onRetry: (item) => { void retry(item); },
    onBreak: setBreaking,
    onSendNote: () => setNoteOpen(true),
    busy,
  };
  return (
    <>
      <section className="space-y-3" aria-labelledby="fleet-status-heading">
        <h2 id="fleet-status-heading" className="text-sm font-semibold">Fleet status</h2>
        <CoordinationErrorBoundary key={snapshot?.at ?? 'none'} label="Fleet status">
          <FleetStatusView
            fleet={snapshot?.fleet}
            error={error}
            loading={loading}
            onRetry={() => { void refresh(); }}
            filter={fleetFilter}
            onFilter={setFleetFilter}
          />
        </CoordinationErrorBoundary>
      </section>
      <section className="space-y-3" aria-labelledby="coordination-heading">
        <h2 id="coordination-heading" className="text-sm font-semibold">Coordination</h2>
        {/* Keyed on the snapshot: a new poll clears a render error without a Retry click. */}
        <CoordinationErrorBoundary key={snapshot?.at ?? 'none'}>
          <CoordinationPanelView snapshot={snapshot} error={error} loading={loading} actions={actions} />
        </CoordinationErrorBoundary>
        <OwnerNoteDialog open={noteOpen} onOpenChange={setNoteOpen} workspaces={workspaces} onDone={() => { void refresh(); }} />
        <LeaseBreakDialog lease={breaking} onClose={() => setBreaking(null)} onDone={() => { void refresh(); }} />
      </section>
    </>
  );
};

export default CoordinationPanel;
