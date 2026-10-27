import { useEffect, useState } from 'react';
import { AlertTriangle, Lock, LockOpen, Pin, RefreshCw } from 'lucide-react';
import dayjs from 'dayjs';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { isFlowStale } from '@/lib/flow';
import { flowDurationText, lockBusyPhrase } from '@/lib/flow-flags';
import { cn } from '@/lib/utils';
import type {
  IFlowDerived, IFlowItem, IFlowLock, IFlowMeter, IFlowQueue, IMissionFlowDetailResponse, IMissionFlowListResponse,
  IMissionFlowSummary,
} from '@/types/flow';

// The flow panel (ADR-0026 decision 8): reads only. Its only requests are the two GETs below; it
// sends nothing to a tab and writes nothing. Every flag comes from the server's `derived` answer.

export const FLOW_LIST_URL = '/api/mission-control/flow';
/** The panel renders no history rows, so it asks for none (as the phone does). */
export const flowDetailUrl = (workspaceId: string): string =>
  `${FLOW_LIST_URL}?workspaceId=${encodeURIComponent(workspaceId)}&history=none`;
export const FLOW_REFRESH_MS = 60_000;

interface ILabel {
  label: string;
  className: string;
}

const own = <T,>(map: Record<string, T>, key: string): T | null => (Object.hasOwn(map, key) ? map[key] : null);

const RULE_LABELS: Record<string, string> = {
  'lock-busy': 'Lock busy',
  'queue-long': 'Queue long',
  'queue-old': 'Oldest item waits',
  'queue-full': 'Queue full',
  'meter-over': 'Meter over limit',
  stale: 'Stale',
};

const SEVERITY_LABELS: Record<string, ILabel> = {
  block: { label: 'Blocking', className: 'border-ui-red/30 bg-ui-red/5 text-ui-red' },
  warn: { label: 'Warning', className: 'border-ui-amber/30 bg-ui-amber/5 text-ui-amber' },
  info: { label: 'Info', className: 'border-ui-blue/30 bg-ui-blue/5 text-ui-blue' },
};
const SEVERITY_FALLBACK: ILabel = { label: 'Notice', className: 'border-border bg-muted/40 text-muted-foreground' };

const ITEM_STATES: Record<string, ILabel> = {
  queued: { label: 'Queued', className: 'bg-ui-gray/50' },
  active: { label: 'Active', className: 'bg-ui-blue' },
  held: { label: 'Held', className: 'bg-ui-amber' },
};
const ITEM_STATE_FALLBACK: ILabel = { label: 'Unknown state', className: 'bg-ui-purple/50' };

const severityOf = (severity: string): ILabel => own(SEVERITY_LABELS, severity) ?? SEVERITY_FALLBACK;
const itemStateOf = (state: string): ILabel => own(ITEM_STATES, state) ?? ITEM_STATE_FALLBACK;
/** The served token beside a neutral fallback word, so an unknown value is still readable; null for a known one. */
const servedDetail = (map: Record<string, unknown>, field: string, value: string): string | null =>
  (Object.hasOwn(map, value) ? null : `${field} ${value}`);

const ageText = (at: number, now: number): string => flowDurationText(dayjs(now).diff(dayjs(at)));
const timeText = (at: number): string => dayjs(at).format('MMM D HH:mm');

const errorOf = async (response: Response, fallback: string): Promise<Error> => {
  const body = await response.json().catch(() => ({})) as { error?: string };
  return new Error(body.error || response.statusText || fallback);
};

const readFlowList = async (url: string): Promise<IMissionFlowListResponse> => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw await errorOf(response, 'Flow unavailable');
  return response.json() as Promise<IMissionFlowListResponse>;
};

const readFlowDetail = async (url: string): Promise<IMissionFlowDetailResponse> => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw await errorOf(response, 'Flow record unavailable');
  return response.json() as Promise<IMissionFlowDetailResponse>;
};

/** The selection to keep: the current one while it is listed, else the newest publisher. A poll never moves it. */
export const flowSelection = (current: string | null, rows: IMissionFlowSummary[]): string | null =>
  (current !== null && rows.some((row) => row.workspaceId === current) ? current : newestFlowWorkspace(rows));

/** The workspace that published most recently: the selector's default. */
export const newestFlowWorkspace = (rows: IMissionFlowSummary[]): string | null =>
  rows.reduce<IMissionFlowSummary | null>((best, row) => (!best || row.receivedAt > best.receivedAt ? row : best), null)?.workspaceId ?? null;

const ErrorLine = ({ text, onRetry }: { text: string; onRetry?: () => void }) => (
  <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-ui-red/30 bg-ui-red/5 p-3 text-sm text-ui-red">
    <span className="break-words">{text}</span>
    {onRetry && <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw className="mr-1 h-3.5 w-3.5" /> Retry</Button>}
  </div>
);

const FlagRow = ({ severity, title, text, details }: { severity: string; title: string; text: string; details: Array<string | null> }) => {
  const look = severityOf(severity);
  const detail = [servedDetail(SEVERITY_LABELS, 'severity', severity), ...details].filter(Boolean).join(' · ');
  return (
    <li className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border px-2 py-1 text-xs', look.className)}>
      <span className="font-medium">{look.label}</span>
      <span className="font-medium">{title}</span>
      <span className="break-words text-foreground">{text}</span>
      {detail && <span className="text-muted-foreground">{detail}</span>}
    </li>
  );
};

const Flags = ({ detail, stale }: { detail: IMissionFlowDetailResponse; stale: boolean }) => {
  const producer = detail.flow?.snapshot.flags ?? [];
  const derived = detail.derived;
  return (
    <div className="space-y-1.5" aria-label="Flow flags">
      {!derived && <p className="text-xs text-muted-foreground">Derived flags not available: this server does not derive them.</p>}
      {derived && derived.flags.length === 0 && producer.length === 0 && (
        <p className="text-xs text-muted-foreground">No flags raised.</p>
      )}
      <ul className="space-y-1">
        {derived?.flags.map((flag) => {
          const title = own(RULE_LABELS, flag.rule);
          return <FlagRow key={`${flag.rule}:${flag.subject}`} severity={flag.severity} title={title ?? 'Flag'} text={flag.text}
            details={[servedDetail(RULE_LABELS, 'rule', flag.rule)]} />;
        })}
        {producer.map((flag, index) => (
          <FlagRow key={`producer:${index}`} severity={flag.severity} title={`From ${detail.flow?.snapshot.source}`} text={flag.text}
            details={[stale ? 'as of the last publish' : null]} />
        ))}
      </ul>
    </div>
  );
};

const QueueBar = ({ queue, now }: { queue: IFlowQueue; now: number }) => {
  const slots = queue.capacity !== null && queue.capacity > queue.items.length ? queue.capacity - queue.items.length : 0;
  const oldest = queue.items.length ? Math.min(...queue.items.map((item) => item.since)) : null;
  const itemTitle = (item: IFlowItem) => [
    item.label ?? item.id, itemStateOf(item.state).label, servedDetail(ITEM_STATES, 'state', item.state), item.pinned ? 'pinned' : null,
    item.holder ? `holder ${item.holder}` : null, `waits ${ageText(item.since, now)}`,
  ].filter(Boolean).join(' · ');
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{queue.name}</span>
        <span className="text-muted-foreground">
          {queue.items.length} {queue.items.length === 1 ? 'item' : 'items'}
          {' · '}{queue.capacity === null ? 'no capacity' : `capacity ${queue.capacity}`}
          {' · '}oldest {oldest === null ? '—' : ageText(oldest, now)}
        </span>
      </div>
      {queue.items.length === 0 && slots === 0 ? (
        <p className="rounded border border-dashed px-2 py-1 text-xs text-muted-foreground">Empty</p>
      ) : (
        <div role="list" aria-label={`${queue.name} items`} className="flex h-4 gap-px overflow-hidden rounded bg-muted">
          {queue.items.map((item) => (
            <span key={item.id} role="listitem" title={itemTitle(item)} data-state={item.state} data-pinned={item.pinned ? 'true' : undefined}
              className={cn('relative min-w-[3px] flex-1', itemStateOf(item.state).className, item.pinned && 'ring-1 ring-inset ring-foreground')}>
              {item.pinned && <Pin aria-label="pinned" className="absolute left-1/2 top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2" />}
            </span>
          ))}
          {slots > 0 && <span aria-label={`${slots} free of capacity`} className="border border-dashed border-border" style={{ flex: slots }} />}
        </div>
      )}
    </div>
  );
};

const busyText = (derived: IFlowDerived | undefined, name: string): string => {
  if (!derived || !Object.hasOwn(derived.lockBusyShare, name) || !Object.hasOwn(derived.lockKnownMinutes, name)) {
    return 'Busy share not available';
  }
  const phrase = lockBusyPhrase(derived.lockBusyShare[name], derived.lockKnownMinutes[name], derived.windowMinutes);
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}`;
};

const LockRow = ({ lock, derived, now }: { lock: IFlowLock; derived?: IFlowDerived; now: number }) => (
  <li className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
    <span className="flex items-center gap-1 font-medium">
      {lock.heldBy === null ? <LockOpen className="h-3.5 w-3.5 text-muted-foreground" /> : <Lock className="h-3.5 w-3.5 text-ui-amber" />}
      {lock.name}
    </span>
    <span className="text-muted-foreground">
      {lock.heldBy === null ? 'Free'
        : `Held by ${lock.heldBy}${lock.since === null ? ', since unknown' : ` since ${timeText(lock.since)} (${ageText(lock.since, now)})`}`}
    </span>
    <span>{busyText(derived, lock.name)}</span>
  </li>
);

const MeterRow = ({ meter }: { meter: IFlowMeter }) => {
  const unit = meter.unit ? ` ${meter.unit}` : '';
  const over = meter.limit !== null && meter.value > meter.limit;
  const pct = meter.limit !== null && meter.limit > 0 ? Math.min(100, Math.max(0, (meter.value / meter.limit) * 100)) : null;
  return (
    <li className="space-y-1 text-xs">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{meter.name}</span>
        <span className={over ? 'font-medium text-ui-red' : 'text-muted-foreground'}>
          {meter.value}{unit}{meter.limit === null ? ' · no limit' : ` of ${meter.limit}${unit}`}
          {meter.windowMinutes !== null && ` · per ${flowDurationText(meter.windowMinutes * 60_000)}`}
        </span>
      </div>
      {pct !== null && (
        <div role="meter" aria-label={`${meter.name} against its limit`} aria-valuemin={0} aria-valuemax={meter.limit ?? undefined}
          aria-valuenow={meter.value} className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full', over ? 'bg-ui-red' : 'bg-ui-blue')} style={{ width: `${pct}%` }} />
        </div>
      )}
    </li>
  );
};

const FlowRecordView = ({ detail, workspaceName, now }: { detail: IMissionFlowDetailResponse; workspaceName: string; now: number }) => {
  if (!detail.flow) {
    return <p className="rounded border border-dashed p-4 text-center text-sm text-muted-foreground">No flow published for {workspaceName}.</p>;
  }
  const { snapshot, receivedAt } = detail.flow;
  // A kept answer ages while refreshes fail: decide stale at render time too, never only as served.
  const stale = detail.stale === true || isFlowStale(receivedAt, now);
  return (
    <div className="space-y-3">
      {stale ? (
        <p role="status" className="flex items-center gap-1 rounded bg-ui-amber/10 px-2 py-1 text-xs font-medium text-ui-amber">
          <AlertTriangle className="h-3.5 w-3.5" /> stale — last published {ageText(receivedAt, now)} ago. The data below is that publish, not the current state.
        </p>
      ) : <p className="text-xs text-muted-foreground">From {snapshot.source} · published {ageText(receivedAt, now)} ago</p>}
      <Flags detail={detail} stale={stale} />
      <div className={cn('grid gap-3 lg:grid-cols-3', stale && 'opacity-60')} data-stale={stale ? 'true' : undefined}>
        <Card className="shadow-none lg:col-span-2"><CardContent className="space-y-3 p-3">
          <h3 className="text-xs font-semibold">Queues</h3>
          {snapshot.queues.length === 0 ? <p className="text-xs text-muted-foreground">No queues published.</p>
            : snapshot.queues.map((queue) => <QueueBar key={queue.name} queue={queue} now={now} />)}
          {snapshot.queues.length > 0 && (
            <p className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
              {Object.values(ITEM_STATES).map((state) => (
                <span key={state.label} className="flex items-center gap-1"><span className={cn('h-2 w-2 rounded-sm', state.className)} />{state.label}</span>
              ))}
              <span className="flex items-center gap-1"><Pin className="h-2.5 w-2.5" /> Pinned</span>
            </p>
          )}
        </CardContent></Card>
        <Card className="shadow-none"><CardContent className="space-y-3 p-3">
          <h3 className="text-xs font-semibold">Locks</h3>
          {snapshot.locks.length === 0 ? <p className="text-xs text-muted-foreground">No locks published.</p> : (
            <ul className="space-y-2">{snapshot.locks.map((lock) => <LockRow key={lock.name} lock={lock} derived={detail.derived} now={now} />)}</ul>
          )}
          <h3 className="text-xs font-semibold">Meters</h3>
          {snapshot.meters.length === 0 ? <p className="text-xs text-muted-foreground">No meters published.</p> : (
            <ul className="space-y-2">{snapshot.meters.map((meter) => <MeterRow key={meter.name} meter={meter} />)}</ul>
          )}
        </CardContent></Card>
      </div>
    </div>
  );
};

/** A server before story 02 sends no derived count: the total is then unknown, never the producer count alone. */
const FlagCount = ({ row }: { row: IMissionFlowSummary }) => {
  if (row.derivedFlagCount === undefined) return <span className="text-muted-foreground">flags —</span>;
  const flags = row.producerFlagCount + row.derivedFlagCount;
  return flags > 0 ? <span className="text-ui-amber">{flags} {flags === 1 ? 'flag' : 'flags'}</span> : null;
};

export interface IFlowPanelContentProps {
  list?: IMissionFlowListResponse;
  listLoading: boolean;
  listError: string | null;
  selected: string | null;
  detail?: IMissionFlowDetailResponse;
  detailLoading: boolean;
  detailError: string | null;
  now: number;
  onSelect?: (workspaceId: string) => void;
  onRetry?: () => void;
}

export const FlowPanelContent = ({
  list, listLoading, listError, selected, detail, detailLoading, detailError, now, onSelect, onRetry,
}: IFlowPanelContentProps) => {
  if (!list) {
    if (listLoading) return null;
    return listError ? <ErrorLine text={`Flow unavailable: ${listError}`} onRetry={onRetry} /> : null;
  }
  // The panel shows once a workspace has a record, or a record cannot be read.
  if (list.workspaces.length === 0 && list.errors.length === 0) return null;
  const current = list.workspaces.find((row) => row.workspaceId === selected) ?? null;
  const shown = detail && detail.workspaceId === selected ? detail : undefined;

  return (
    <section className="space-y-3" aria-label="Flow">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">Flow</h2>
          <p className="text-xs text-muted-foreground">Queues, locks and meters each orchestrator publishes, with the flags the server derives.</p>
        </div>
        {list.workspaces.length > 0 && (
          <div role="group" aria-label="Workspace" className="flex flex-wrap gap-1">
            {list.workspaces.map((row) => (
              <Button key={row.workspaceId} size="xs" variant={row.workspaceId === selected ? 'secondary' : 'ghost'}
                aria-pressed={row.workspaceId === selected} onClick={() => onSelect?.(row.workspaceId)}>
                {row.workspaceName}
                {row.stale && <span className="text-ui-amber">stale</span>}
                <FlagCount row={row} />
              </Button>
            ))}
          </div>
        )}
      </div>
      {listError && <p role="alert" className="text-xs text-ui-red">Refresh failed: {listError}. Showing the last answer.</p>}
      {list.errors.map((entry) => (
        <ErrorLine key={entry.workspaceId} text={`Flow for ${entry.workspaceId} unreadable: ${entry.error}`} />
      ))}
      {current && (shown ? <>
        {detailError && <p role="alert" className="text-xs text-ui-red">Refresh failed: {detailError}. Showing the last answer.</p>}
        <FlowRecordView detail={shown} workspaceName={current.workspaceName} now={now} />
      </> : detailError ? <ErrorLine text={`Flow for ${current.workspaceName} unreadable: ${detailError}`} onRetry={onRetry} />
        : detailLoading ? <p className="text-xs text-muted-foreground">Loading {current.workspaceName} flow…</p> : null)}
    </section>
  );
};

const FlowPanel = () => {
  const [chosen, setChosen] = useState<string | null>(null);
  // Each poll answer keeps the selection once made; only a workspace that leaves the list moves it.
  const list = useSWR(FLOW_LIST_URL, readFlowList, {
    refreshInterval: FLOW_REFRESH_MS,
    onSuccess: (data) => setChosen((current) => flowSelection(current, data.workspaces)),
  });
  const selected = flowSelection(chosen, list.data?.workspaces ?? []);
  const detail = useSWR(selected ? flowDetailUrl(selected) : null, readFlowDetail, { refreshInterval: FLOW_REFRESH_MS });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), FLOW_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const message = (error: unknown, fallback: string): string | null => (error ? (error instanceof Error ? error.message : fallback) : null);
  return (
    <FlowPanelContent list={list.data} listLoading={list.isLoading} listError={message(list.error, 'Flow unavailable')}
      selected={selected} detail={detail.data} detailLoading={detail.isLoading} detailError={message(detail.error, 'Flow record unavailable')}
      now={now} onSelect={setChosen} onRetry={() => { void list.mutate(); void detail.mutate(); }} />
  );
};

export default FlowPanel;
