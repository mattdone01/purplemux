import { MissionControlError } from '@/lib/mission-control-errors';
import { resolveMissionTargetIdentity } from '@/lib/mission-control-runtime';
import { getMissionControlStore, type IMissionEventAuthority, type IMissionItemOpener } from '@/lib/mission-control-store';
import { parseMissionEventBatch } from '@/lib/mission-control-validation';
import { readQuestionMinVersion } from '@/lib/mission-question-config';
import { getWorkspaceById } from '@/lib/workspace-store';

/**
 * One batch of Mission Control producer events for one workspace: the validator (question format
 * included, ADR-0037), the server-resolved identities, the orchestrator authority a human review needs,
 * then the store. The events route and the server's own producers (ADR-0041) share it, so a server-made
 * item passes exactly the checks an agent's does.
 */
export const applyMissionEventBatch = async (
  workspaceId: string,
  rawEvents: unknown,
  opener: IMissionItemOpener | null,
  options: { serverPrefix?: string } = {},
) => {
  const questionMinVersion = await readQuestionMinVersion();
  const { events, lint } = parseMissionEventBatch(rawEvents, { questionMinVersion, serverPrefix: options.serverPrefix });
  if (events.some((event) => event.workspaceId !== workspaceId)) {
    throw new MissionControlError(403, 'forbidden', 'Every event must match the authorized workspace');
  }
  const store = getMissionControlStore();
  const unreplayed = store.unreplayedEventIds(events);
  const identities = new Map<string, Awaited<ReturnType<typeof resolveMissionTargetIdentity>>>();
  await Promise.all(events.map(async (event) => {
    if (!unreplayed.has(event.eventId)) return;
    const tabId = event.type === 'run.started' || event.type === 'run.resumed'
      ? event.payload.tabId
      : (event.type === 'attention.opened' || event.type === 'attention.updated')
        ? event.payload.humanReview?.reviewerTabId
        : undefined;
    if (tabId) identities.set(event.eventId, await resolveMissionTargetIdentity(event.workspaceId, tabId));
  }));
  const needsReviewAuthority = events.some((event) => unreplayed.has(event.eventId)
    && (event.type === 'attention.opened' || event.type === 'attention.updated')
    && event.payload.humanReview !== undefined);
  const configuredOrchestratorTabId = needsReviewAuthority
    ? (await getWorkspaceById(workspaceId))?.orchestration?.orchestratorTabId ?? null
    : null;
  const authorities = new Map<string, IMissionEventAuthority>();
  for (const event of events) {
    if (!unreplayed.has(event.eventId)) continue;
    authorities.set(event.eventId, {
      resolvedIdentity: identities.get(event.eventId) ?? null,
      configuredOrchestratorTabId,
      opener: event.type === 'attention.opened' ? opener : null,
    });
  }
  return {
    ...store.applyEvents(events, authorities, { questionMinVersion }),
    humanInboxPolicy: store.humanInboxPolicy(workspaceId),
    lint,
  };
};
