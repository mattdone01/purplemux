import type { ReactNode } from 'react';
import { AlertCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import MissionControlAnswerCard from '@/components/features/mission-control/mission-control-answer-card';
import { isMissionHumanInboxItem } from '@/components/features/mission-control/mission-control-utils';
import type { IMissionDraft, IMissionDraftPatch } from '@/components/features/mission-control/mission-control-utils';
import type {
  IMissionAttentionItem,
  IMissionSnapshot,
  IMissionWorkspaceView,
} from '@/types/mission-control';

export const SectionHeading = ({
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

export const EmptyPanel = ({ children }: { children: ReactNode }) => (
  <div className="rounded-lg border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-muted-foreground">
    {children}
  </div>
);

interface INeedsYouGroup {
  workspaceId: string;
  workspace: IMissionWorkspaceView | undefined;
  items: IMissionAttentionItem[];
}

/** Oldest question first inside a workspace; the workspace holding the oldest question leads. */
export const needsYouGroups = (
  items: IMissionAttentionItem[],
  workspaces: IMissionWorkspaceView[],
): INeedsYouGroup[] => {
  const grouped = new Map<string, IMissionAttentionItem[]>();
  for (const item of items) {
    grouped.set(item.workspaceId, [...(grouped.get(item.workspaceId) ?? []), item]);
  }
  return [...grouped.entries()]
    .map(([workspaceId, groupedItems]) => ({
      workspaceId,
      workspace: workspaces.find((workspace) => workspace.workspaceId === workspaceId),
      items: [...groupedItems].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => left.items[0].createdAt - right.items[0].createdAt
      || left.workspaceId.localeCompare(right.workspaceId));
};

interface INeedsYouHandlers {
  drafts: Record<string, IMissionDraft>;
  onDraftChange: (item: IMissionAttentionItem, patch: IMissionDraftPatch) => void;
  onAdoptCurrent: (itemId: string) => void;
  onSubmit: (item: IMissionAttentionItem) => void;
}

const HEADING_ID = 'needs-you-heading';
const TITLE = 'Needs you';
const DESCRIPTION = 'Decisions and actions explicitly escalated for you.';

const NeedsYouList = ({
  snapshot,
  drafts,
  onDraftChange,
  onAdoptCurrent,
  onSubmit,
}: INeedsYouHandlers & { snapshot: IMissionSnapshot }) => {
  const items = snapshot.items.filter(isMissionHumanInboxItem);
  return (
    <>
      <div id={HEADING_ID}>
        <SectionHeading title={TITLE} count={items.length} description={DESCRIPTION} />
      </div>
      {items.length === 0 ? (
        <EmptyPanel>No confirmed questions need an answer.</EmptyPanel>
      ) : needsYouGroups(items, snapshot.workspaces).map(({ workspaceId, workspace, items: groupItems }) => (
        <div key={workspaceId} className="min-w-0 space-y-3">
          <p className="break-words text-xs font-medium text-muted-foreground">{workspace?.name ?? workspaceId}</p>
          <div className="grid min-w-0 gap-3 xl:grid-cols-2">
            {groupItems.map((item) => {
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
    </>
  );
};

interface IMissionControlNeedsYouProps extends INeedsYouHandlers {
  snapshot: IMissionSnapshot | null;
  loading: boolean;
  unsupported: boolean;
  error: string | null;
  refreshing: boolean;
  onRetry: () => void;
}

const MissionControlNeedsYou = ({
  snapshot,
  loading,
  unsupported,
  error,
  refreshing,
  onRetry,
  ...handlers
}: IMissionControlNeedsYouProps) => {
  let body: ReactNode;
  if (snapshot) {
    body = (
      <>
        {error && (
          <div role="status" className="flex items-start gap-2 rounded-md border border-ui-red/20 bg-ui-red/5 px-3 py-2 text-sm text-ui-red">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">Live refresh failed: {error}. Showing the last confirmed snapshot.</span>
          </div>
        )}
        <NeedsYouList snapshot={snapshot} {...handlers} />
      </>
    );
  } else {
    const retry = (
      <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={refreshing} className="w-full shrink-0 sm:w-auto">
        <RefreshCw className="h-4 w-4" />Retry
      </Button>
    );
    let state: ReactNode;
    if (loading) {
      state = (
        <div role="status" aria-live="polite" className="space-y-3">
          <span className="sr-only">Loading the questions that need you…</span>
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      );
    } else if (unsupported) {
      state = (
        <div role="status" className="flex flex-col gap-3 rounded-lg border border-ui-amber/30 bg-ui-amber/5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <span className="flex min-w-0 items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-ui-amber" />
            <span className="min-w-0 break-words">This PurpleMux server does not expose the Mission Control API, so open questions cannot be shown.</span>
          </span>
          {retry}
        </div>
      );
    } else {
      state = (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-ui-red/20 bg-ui-red/5 px-4 py-3 text-sm text-ui-red sm:flex-row sm:items-center sm:justify-between">
          <span className="flex min-w-0 items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 break-words">Questions could not load: {error || 'the server did not return a snapshot'}.</span>
          </span>
          {retry}
        </div>
      );
    }
    body = (
      <>
        <div id={HEADING_ID}>
          <SectionHeading title={TITLE} description={DESCRIPTION} />
        </div>
        {state}
      </>
    );
  }

  return (
    <section className="min-w-0 space-y-3" aria-labelledby={HEADING_ID}>
      {body}
    </section>
  );
};

export default MissionControlNeedsYou;
