import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PortfolioBoardContent } from '@/components/features/mission-control/portfolio-board';
import { portfolioCoverage, portfolioProducerAuthorized, portfolioVisibleDependencies } from '@/lib/portfolio-service';
import type { ICaller } from '@/lib/caller';
import type { IMissionRun } from '@/types/mission-control';
import type { IPortfolioSelection, IPortfolioSnapshot } from '@/types/portfolio';
import type { IWorkspace } from '@/types/terminal';

const selection: IPortfolioSelection = { managerWorkspaceId: 'ws-root', managerTabId: 'tab-root', workspaceIds: ['ws-a', 'ws-b'] };
const workspace = (id: string): IWorkspace => ({ id, name: id,
  orchestration: { enabled: true, orchestratorTabId: `tab-${id}` },
} as IWorkspace);
describe('portfolio board scope and presentation', () => {
  it('rejects foreign workers and stale replacement generations', () => {
    const caller = { verified: true, workspaceId: 'ws-a', tabId: 'tab-a' } as ICaller;
    const run = { workspaceId: 'ws-a', state: 'waiting', binding: { tabId: 'tab-a', generation: 2 } } as IMissionRun;
    expect(portfolioProducerAuthorized(caller, 'ws-a', run, 2, true)).toBe(true);
    expect(portfolioProducerAuthorized(caller, 'ws-a', run, 1, true)).toBe(false);
    expect(portfolioProducerAuthorized(caller, 'ws-a', run, 2, false)).toBe(false);
    expect(portfolioProducerAuthorized({ ...caller, verified: false }, 'ws-a', run, 2, true)).toBe(false);
    expect(portfolioProducerAuthorized(caller, 'ws-b', run, 2, true)).toBe(false);
  });
  it('filters shared aggregates to current coordinators without a separate grant', () => {
    const workspaces = [workspace('ws-root'), workspace('ws-a'), workspace('ws-b')];
    const coverage = portfolioCoverage(selection, workspaces, true);
    expect(coverage.map((entry) => entry.access)).toEqual(['available', 'available']);
    const missing = portfolioCoverage(selection, workspaces, false);
    expect(missing.map((entry) => entry.access)).toEqual(['coordinator-missing', 'coordinator-missing']);
    const impacts = [
      { id: 'pb-a', workspaceId: 'ws-a', resourceKey: 'lease:merge', kind: 'lease', firstBlockedAt: 10 },
      { id: 'pb-b', workspaceId: 'ws-b', resourceKey: 'lease:merge', kind: 'lease', firstBlockedAt: 20 },
    ] as Parameters<typeof portfolioVisibleDependencies>[0];
    expect(portfolioVisibleDependencies(impacts, coverage, new Map())[0].impacts).toHaveLength(2);
    expect(portfolioVisibleDependencies(impacts, missing, new Map())).toEqual([]);
    const absentTab = portfolioCoverage(selection, workspaces, true,
      new Map([['ws-a', false], ['ws-b', true]]));
    expect(absentTab.map((entry) => entry.access)).toEqual(['coordinator-missing', 'available']);
  });

  it('shows the highest priority release, action, capacity reason and incomplete coverage on mobile cards', () => {
    const impact = {
      id: 'pb-a', schemaVersion: 1 as const, workspaceId: 'ws-a', runId: 'run-a', sourceKey: 'source-a', revision: 0,
      resourceKey: 'lease:merge:owner/repo', kind: 'lease' as const, watchId: 'w-a', watchHead: null,
      outcome: 'Release payouts', priority: 90, stage: 'implemented' as const, owner: 'owner-a',
      cause: 'Lease held', evidence: 'orchestrator report', nextAction: 'Ask holder to release lease',
      decisionOwner: 'owner-a', checkpointAt: 100, capacity: { host: 'host-a', measuredReason: 'lease held',
        limit: '1', use: '1', holder: 'tab-holder', clearingCondition: 'lease free' }, state: 'received' as const,
      firstBlockedAt: 1, updatedAt: 2, proof: null, noteId: null, noteState: null,
      noteDeliveredAt: null, escalatedAt: null,
    };
    const lower = { ...impact, id: 'pb-b', workspaceId: 'ws-b', runId: 'run-b', outcome: 'Release lower', priority: 20 };
    const snapshot: IPortfolioSnapshot = {
      selection, coverage: [{ workspaceId: 'ws-a', name: 'A', access: 'available' },
        { workspaceId: 'ws-b', name: 'B', access: 'coordinator-missing' }],
      dependencies: [{ resourceKey: impact.resourceKey, kind: 'lease', firstBlockedAt: 1, impacts: [impact, lower] }],
      actions: [],
      milestones: [{ workspaceId: 'ws-a', runId: 'run-a', stage: 'verified', source: 'human-confirmed',
        evidence: 'Release probe verified on production', observedAt: 900, actor: 'human-1' }],
      generatedAt: 1_000,
    };
    const html = renderToStaticMarkup(<PortfolioBoardContent snapshot={snapshot} priorityFilter="top"
      onPriorityFilter={() => {}} decisions={{}} onDecision={() => {}} pendingId={null}
      onAcknowledge={() => {}} onAssign={() => {}} />);
    expect(html).toContain('Release payouts');
    expect(html).not.toContain('Release lower');
    expect(html).toContain('Ask holder to release lease');
    expect(html).toContain('Coverage incomplete');
    expect(html).toContain('Host: host-a');
    expect(html).toContain('Last human-confirmed milestone: verified');
    expect(html).toContain('Confirmed by human-1');
    expect(html).toContain('sm:grid-cols-2');
  });
});
