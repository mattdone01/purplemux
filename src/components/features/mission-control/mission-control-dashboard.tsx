import { useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Bot,
  ChevronDown,
  CircleDot,
  Clock3,
  ExternalLink,
  History,
  RefreshCw,
  Search,
  TriangleAlert,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import MissionControlAnswerCard, {
  MissionControlDeliveryCard,
} from '@/components/features/mission-control/mission-control-answer-card';
import { formatMissionAge, isMissionDraftEmpty } from '@/components/features/mission-control/mission-control-utils';
import type { IMissionDraft, IMissionDraftPatch } from '@/components/features/mission-control/mission-control-utils';
import type {
  IMissionAttentionItem,
  IMissionBootstrapEntry,
  IMissionRun,
  IMissionSnapshot,
  IMissionWorkspaceView,
  TMissionActivity,
} from '@/types/mission-control';

interface IMissionControlDashboardProps {
  snapshot: IMissionSnapshot;
  drafts: Record<string, IMissionDraft>;
  refreshing: boolean;
  bootstrapPending: boolean;
  bootstrapError: string | null;
  onRefresh: () => void;
  onDraftChange: (item: IMissionAttentionItem, patch: IMissionDraftPatch) => void;
  onAdoptCurrent: (itemId: string) => void;
  onSubmit: (item: IMissionAttentionItem) => void;
  onOpenWorkspace: (workspaceId: string) => void;
  onBootstrap: () => void;
}

const activityStyles: Record<TMissionActivity, string> = {
  active: 'bg-ui-teal/10 text-ui-teal',
  waiting: 'bg-ui-amber/10 text-ui-amber',
  dormant: 'bg-muted text-muted-foreground',
  unknown: 'bg-ui-gray/10 text-ui-gray',
};

const entryStyles: Record<IMissionBootstrapEntry['state'], string> = {
  provisional: 'text-ui-gray',
  queued: 'text-ui-blue',
  dispatching: 'text-ui-blue',
  submitted: 'text-ui-amber',
  confirmed: 'text-ui-teal',
  held: 'text-ui-red',
};

const entryLabels: Record<IMissionBootstrapEntry['state'], string> = {
  provisional: 'Context found',
  queued: 'Confirmation queued',
  dispatching: 'Checking delivery',
  submitted: 'Confirmation requested',
  confirmed: 'Confirmed',
  held: 'Needs attention',
};

const bootstrapReasonLabel = (reason: string | null): string | null => {
  if (!reason) return null;
  const label = reason.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return label ? `${label[0].toUpperCase()}${label.slice(1)}` : null;
};

const itemGroups = (
  items: IMissionAttentionItem[],
  workspaces: IMissionWorkspaceView[],
): Array<{ workspace: IMissionWorkspaceView | undefined; items: IMissionAttentionItem[] }> => {
  const grouped = new Map<string, IMissionAttentionItem[]>();
  for (const item of items) {
    grouped.set(item.workspaceId, [...(grouped.get(item.workspaceId) ?? []), item]);
  }
  return [...grouped.entries()].map(([workspaceId, groupedItems]) => ({
    workspace: workspaces.find((workspace) => workspace.workspaceId === workspaceId),
    items: groupedItems.sort((left, right) => left.createdAt - right.createdAt),
  }));
};

const currentRun = (workspace: IMissionWorkspaceView, runs: IMissionRun[]): IMissionRun | undefined =>
  runs
    .filter((run) => workspace.runIds.includes(run.id))
    .sort((left, right) => {
      const leftCurrent = left.state === 'running' || left.state === 'waiting' ? 1 : 0;
      const rightCurrent = right.state === 'running' || right.state === 'waiting' ? 1 : 0;
      return rightCurrent - leftCurrent || right.updatedAt - left.updatedAt;
    })[0];

const SectionHeading = ({
  title,
  count,
  description,
}: {
  title: string;
  count?: number;
  description: string;
}) => (
  <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
    <div>
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {count !== undefined && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  </div>
);

const EmptyPanel = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-lg border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-muted-foreground">
    {children}
  </div>
);

const CandidateCard = ({
  item,
  workspaceName,
}: {
  item: IMissionAttentionItem;
  workspaceName: string;
}) => (
  <Card className="min-w-0 border-dashed border-ui-amber/30 bg-ui-amber/5 shadow-none">
    <CardContent className="space-y-3 p-4 sm:p-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="rounded bg-background/80 px-2 py-1 font-medium">{workspaceName}</span>
        <span className="text-ui-amber">Provisional candidate</span>
        <span className="text-muted-foreground">· {item.evidence.source}</span>
      </div>
      <div>
        <p className="break-words text-sm font-medium">{item.title}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{item.context}</p>
      </div>
      <div className="flex items-start gap-2 rounded-md bg-background/70 px-3 py-2 text-xs text-muted-foreground">
        <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Awaiting orchestrator confirmation. This is not yet an actionable question.</span>
      </div>
    </CardContent>
  </Card>
);

const BootstrapPanel = ({
  snapshot,
  pending,
  error,
  onBootstrap,
}: {
  snapshot: IMissionSnapshot;
  pending: boolean;
  error: string | null;
  onBootstrap: () => void;
}) => {
  const bootstrap = snapshot.bootstrap;
  if (bootstrap) {
    const confirmed = bootstrap.entries.filter((entry) => entry.state === 'confirmed').length;
    const pendingCount = bootstrap.entries.filter((entry) =>
      entry.state === 'queued' || entry.state === 'dispatching' || entry.state === 'submitted').length;
    const needsAttention = bootstrap.entries.filter((entry) =>
      entry.state === 'held' || entry.state === 'provisional').length;
    return (
      <details className="group rounded-lg border border-foreground/10 bg-card/50">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
          <span className="flex min-w-0 items-center gap-2 font-medium">
            <Search className="h-4 w-4 shrink-0 text-ui-purple" />
            <span className="truncate">Workspace discovery</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            <span>{confirmed} confirmed</span>
            {pendingCount > 0 && <span className="text-ui-blue">{pendingCount} pending</span>}
            {needsAttention > 0 && <span className="text-ui-amber">{needsAttention} to review</span>}
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="flex min-w-0 flex-col gap-3 border-t border-foreground/10 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
          <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-2 text-xs">
            {bootstrap.entries.length === 0 ? (
              <span className="text-muted-foreground">Discovery completed with no workspace entries.</span>
            ) : bootstrap.entries.map((entry) => {
              const workspaceName = snapshot.workspaces.find((workspace) =>
                workspace.workspaceId === entry.workspaceId)?.name ?? 'Unavailable workspace';
              const reason = bootstrapReasonLabel(entry.reason);
              return (
                <span key={`${entry.workspaceId}:${entry.runId}`} className={entryStyles[entry.state]}>
                  {workspaceName}: {entryLabels[entry.state]}{reason ? ` · ${reason}` : ''}
                </span>
              );
            })}
            {error && <span className="w-full text-ui-red">{error}. Your discovery request is saved and can be retried safely.</span>}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={onBootstrap}
            className="w-full shrink-0 sm:w-auto"
          >
            {pending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            {pending ? 'Discovering…' : error ? 'Retry discovery' : 'Discover again'}
          </Button>
        </div>
      </details>
    );
  }

  return (
    <Card className="border-foreground/10 bg-card/60 shadow-none">
      <CardContent className="flex min-w-0 flex-col gap-4 p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-ui-purple" />
            <p className="text-sm font-medium">Workspace discovery</p>
          </div>
          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
            Inspect current PurpleMux workspaces and ask eligible orchestrators once to confirm provisional context.
          </p>
          {error && <p className="mt-2 text-xs text-ui-red">{error}. Your discovery request is saved and can be retried safely.</p>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={onBootstrap}
          className="w-full shrink-0 sm:w-auto"
        >
          {pending ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          {pending ? 'Discovering…' : error ? 'Retry discovery' : 'Discover workspaces'}
        </Button>
      </CardContent>
    </Card>
  );
};

const WorkspaceCard = ({
  workspace,
  runs,
  onOpen,
}: {
  workspace: IMissionWorkspaceView;
  runs: IMissionRun[];
  onOpen: () => void;
}) => {
  const run = currentRun(workspace, runs);
  return (
    <Card className="min-w-0 border-foreground/10 shadow-none">
      <CardHeader className="space-y-3 px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <CardTitle className="truncate text-sm">{workspace.name}</CardTitle>
              <span className={cn('rounded px-2 py-0.5 text-xs font-medium capitalize', activityStyles[workspace.activity])}>
                {workspace.activity}
              </span>
              {workspace.stale && <span className="text-xs text-ui-amber">Progress may be stale</span>}
              {workspace.orphaned && <span className="text-xs text-ui-red">Workspace removed</span>}
            </div>
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {run?.objective || 'No current objective reported'}
            </p>
          </div>
          {!workspace.orphaned && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={onOpen} aria-label={`Open ${workspace.name}`}>
              <ArrowUpRight className="h-4 w-4" />
            </Button>
          )}
        </div>
        {run?.epic && (
          run.epic.url ? (
            <a
              href={run.epic.url}
              target="_blank"
              rel="noreferrer"
              className="flex min-w-0 items-center gap-1.5 text-xs text-ui-blue hover:underline"
            >
              <span className="truncate">{run.epic.id} · {run.epic.title}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <p className="truncate text-xs text-ui-blue">{run.epic.id} · {run.epic.title}</p>
          )
        )}
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-5 sm:pb-5">
        <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Phase</p>
            <p className="mt-1 break-words font-medium">{run?.phase || 'Unknown'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Stories</p>
            <p className="mt-1 font-medium tabular-nums">
              {run?.storyCounts ? `${run.storyCounts.done}/${run.storyCounts.total}` : 'Not reported'}
            </p>
          </div>
          <div>
            <p className="text-muted-foreground">Last progress</p>
            <p className="mt-1 font-medium">{formatMissionAge(workspace.lastProgressAt)}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Last activity</p>
            <p className="mt-1 font-medium">{formatMissionAge(workspace.lastActivityAt)}</p>
          </div>
        </div>

        {(workspace.openItems > 0 || workspace.awaitingAcknowledgement > 0 || run?.closeoutPending) && (
          <div className="flex flex-wrap gap-2 text-xs">
            {workspace.openItems > 0 && (
              <span className="rounded bg-ui-amber/10 px-2 py-1 text-ui-amber">
                {workspace.openItems} need{workspace.openItems === 1 ? 's' : ''} you
              </span>
            )}
            {workspace.awaitingAcknowledgement > 0 && (
              <span className="rounded bg-ui-blue/10 px-2 py-1 text-ui-blue">
                {workspace.awaitingAcknowledgement} awaiting acknowledgement
              </span>
            )}
            {run?.closeoutPending && (
              <span className="rounded bg-ui-purple/10 px-2 py-1 text-ui-purple">Epic closeout pending</span>
            )}
          </div>
        )}

        {run?.nextStep && (
          <div className="rounded-md bg-muted/60 px-3 py-2 text-xs">
            <span className="text-muted-foreground">Next: </span>
            <span className="break-words">{run.nextStep}</span>
          </div>
        )}

        <div className="flex min-w-0 flex-wrap gap-2">
          {workspace.agents.length === 0 ? (
            <span className="text-xs text-muted-foreground">No agent runtime observed</span>
          ) : workspace.agents.map((agent) => (
            <span
              key={agent.tabId}
              className="inline-flex max-w-full items-center gap-1.5 rounded bg-muted px-2 py-1 text-xs"
              title={`${agent.providerId} · ${agent.cliState ?? 'unknown'}`}
            >
              <Bot className={cn('h-3 w-3 shrink-0', agent.alive ? 'text-ui-teal' : 'text-ui-gray')} />
              <span className="truncate">{agent.name}</span>
              <span className="text-muted-foreground">{agent.cliState ?? (agent.alive ? 'connected' : 'offline')}</span>
            </span>
          ))}
        </div>

        <p className="text-[11px] text-muted-foreground">
          {workspace.evidence.confidence} · {workspace.evidence.source} · observed {formatMissionAge(workspace.evidence.observedAt)}
        </p>
      </CardContent>
    </Card>
  );
};

export const MissionControlDashboardSkeleton = () => (
  <div className="space-y-6 px-3 py-5 sm:px-5 lg:px-8">
    <div className="space-y-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-72 max-w-full" /></div>
    <Skeleton className="h-28 w-full" />
    <div className="grid gap-3 lg:grid-cols-2"><Skeleton className="h-56" /><Skeleton className="h-56" /></div>
  </div>
);

const MissionControlDashboard = ({
  snapshot,
  drafts,
  refreshing,
  bootstrapPending,
  bootstrapError,
  onRefresh,
  onDraftChange,
  onAdoptCurrent,
  onSubmit,
  onOpenWorkspace,
  onBootstrap,
}: IMissionControlDashboardProps) => {
  const [activityFilter, setActivityFilter] = useState<TMissionActivity>('active');
  const openItems = snapshot.items.filter((item) => item.state === 'open');
  const retainedDraftItems = Object.values(drafts)
    .filter((draft) => !isMissionDraftEmpty(draft) && !openItems.some((item) => item.id === draft.item.id))
    .map((draft) => draft.item);
  const actionableItems = [...openItems, ...retainedDraftItems];
  const candidateItems = snapshot.items.filter((item) => item.state === 'candidate');
  const answeredItems = snapshot.items.filter((item) => item.state === 'answered');
  const filteredWorkspaces = snapshot.workspaces.filter((workspace) => workspace.activity === activityFilter);
  const counts = useMemo(() => Object.fromEntries(
    (['active', 'waiting', 'dormant', 'unknown'] as const).map((activity) => [
      activity,
      snapshot.workspaces.filter((workspace) => workspace.activity === activity).length,
    ]),
  ) as Record<TMissionActivity, number>, [snapshot.workspaces]);

  return (
    <div className="mx-auto w-full max-w-[1440px] space-y-8 px-3 py-5 sm:px-5 sm:py-6 lg:px-8">
      <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-ui-purple" />
            <h1 className="text-base font-semibold">Mission Control</h1>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Your decisions and active work across all workspaces.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Updated {formatMissionAge(snapshot.generatedAt)}</span>
          <Button type="button" variant="ghost" size="icon-sm" onClick={onRefresh} disabled={refreshing} aria-label="Refresh Mission Control">
            <RefreshCw className={cn('h-4 w-4', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </header>

      <BootstrapPanel snapshot={snapshot} pending={bootstrapPending} error={bootstrapError} onBootstrap={onBootstrap} />

      <section className="space-y-3" aria-labelledby="needs-you-heading">
        <div id="needs-you-heading">
          <SectionHeading
            title="Needs you"
            count={actionableItems.length}
            description="Confirmed questions remain here until the server accepts an answer."
          />
        </div>
        {actionableItems.length === 0 ? (
          <EmptyPanel>No confirmed questions need an answer.</EmptyPanel>
        ) : itemGroups(actionableItems, snapshot.workspaces).map(({ workspace, items }) => (
          <div key={workspace?.workspaceId ?? items[0].workspaceId} className="space-y-3">
            <p className="text-xs font-medium text-muted-foreground">{workspace?.name ?? items[0].workspaceId}</p>
            <div className="grid min-w-0 gap-3 xl:grid-cols-2">
              {items.map((item) => {
                const draft = drafts[item.id];
                if (!draft) return null;
                return (
                  <MissionControlAnswerCard
                    key={item.id}
                    draft={draft}
                    workspaceName={workspace?.name ?? item.workspaceId}
                    onChange={(patch) => onDraftChange(item, patch)}
                    onAdoptCurrent={() => onAdoptCurrent(item.id)}
                    onSubmit={() => onSubmit(item)}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {answeredItems.length > 0 && (
        <section className="space-y-3" aria-labelledby="answer-delivery-heading">
          <div id="answer-delivery-heading">
            <SectionHeading
              title="Answer delivery"
              count={answeredItems.length}
              description="Saved, delivered, and acknowledged are separate states."
            />
          </div>
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            {answeredItems.map((item) => {
              const answer = snapshot.answers.find((candidate) => candidate.id === item.answerId);
              const delivery = snapshot.deliveries.find((candidate) => candidate.answerId === item.answerId);
              const workspace = snapshot.workspaces.find((candidate) => candidate.workspaceId === item.workspaceId);
              return (
                <MissionControlDeliveryCard
                  key={item.id}
                  item={item}
                  answer={answer}
                  delivery={delivery}
                  workspaceName={workspace?.name ?? item.workspaceId}
                />
              );
            })}
          </div>
        </section>
      )}

      <section className="space-y-3" aria-labelledby="workspaces-heading">
        <div id="workspaces-heading">
          <SectionHeading
            title="Workspaces"
            count={snapshot.workspaces.length}
            description="Activity is observed separately from meaningful progress and reported completion."
          />
        </div>
        <div className="flex max-w-full gap-1 overflow-x-auto pb-1">
          {(['active', 'waiting', 'dormant', 'unknown'] as const).map((activity) => (
            <Button
              key={activity}
              type="button"
              size="sm"
              variant={activityFilter === activity ? 'secondary' : 'ghost'}
              onClick={() => setActivityFilter(activity)}
              className="shrink-0 capitalize"
            >
              {activity} <span className="tabular-nums text-muted-foreground">{counts[activity]}</span>
            </Button>
          ))}
        </div>
        {snapshot.workspaces.length === 0 ? (
          <EmptyPanel>
            <Search className="mx-auto mb-2 h-5 w-5" />
            No workspaces have been discovered yet.
          </EmptyPanel>
        ) : filteredWorkspaces.length === 0 ? (
          <EmptyPanel>No {activityFilter} workspaces.</EmptyPanel>
        ) : (
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            {filteredWorkspaces.map((workspace) => (
              <WorkspaceCard
                key={workspace.workspaceId}
                workspace={workspace}
                runs={snapshot.runs}
                onOpen={() => onOpenWorkspace(workspace.workspaceId)}
              />
            ))}
          </div>
        )}
      </section>

      {candidateItems.length > 0 && (
        <section className="space-y-3" aria-labelledby="candidate-heading">
          <div id="candidate-heading">
            <SectionHeading
              title="Provisional candidates"
              count={candidateItems.length}
              description="Discovery found these in historical context; an orchestrator must confirm them before they become actionable."
            />
          </div>
          <div className="grid min-w-0 gap-3 lg:grid-cols-2">
            {candidateItems.map((item) => (
              <CandidateCard
                key={item.id}
                item={item}
                workspaceName={snapshot.workspaces.find((workspace) => workspace.workspaceId === item.workspaceId)?.name ?? item.workspaceId}
              />
            ))}
          </div>
        </section>
      )}

      <details className="group rounded-lg border border-foreground/10 bg-card/50">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium sm:px-5">
          <span className="flex items-center gap-2"><History className="h-4 w-4 text-ui-gray" />Recent changes</span>
          <span className="flex items-center gap-2 text-xs font-normal text-muted-foreground">
            {snapshot.recentEvents.length}
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="border-t border-foreground/10 px-4 py-2 sm:px-5">
          {snapshot.recentEvents.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">No recent semantic changes.</p>
          ) : snapshot.recentEvents.map((event) => {
            const workspace = snapshot.workspaces.find((candidate) => candidate.workspaceId === event.workspaceId);
            return (
              <div key={event.id} className="flex min-w-0 items-start gap-3 border-b border-foreground/5 py-3 last:border-0">
                <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ui-purple" />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm">{event.type}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {workspace?.name ?? event.workspaceId} · {formatMissionAge(event.committedAt)}
                  </p>
                </div>
                {workspace && !workspace.orphaned && (
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => onOpenWorkspace(workspace.workspaceId)} aria-label={`Open ${workspace.name}`}>
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </details>
    </div>
  );
};

export const MissionControlErrorState = ({
  unsupported,
  error,
  onRetry,
}: {
  unsupported: boolean;
  error: string | null;
  onRetry: () => void;
}) => (
  <div className="flex min-h-0 flex-1 items-center justify-center px-3 py-8 sm:px-5">
    <Card className="w-full max-w-lg border-foreground/10 shadow-none">
      <CardContent className="space-y-4 p-5 text-center sm:p-6">
        {unsupported ? <TriangleAlert className="mx-auto h-6 w-6 text-ui-amber" /> : <AlertCircle className="mx-auto h-6 w-6 text-ui-red" />}
        <div>
          <p className="text-sm font-medium">{unsupported ? 'Mission Control is unavailable' : 'Mission Control could not load'}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {unsupported ? 'This PurpleMux server does not expose the Mission Control API yet.' : error || 'The server did not return a snapshot.'}
          </p>
        </div>
        <Button type="button" variant="outline" onClick={onRetry}><RefreshCw className="h-4 w-4" />Try again</Button>
      </CardContent>
    </Card>
  </div>
);

export default MissionControlDashboard;
