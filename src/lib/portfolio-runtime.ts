import { getNotesService } from '@/lib/notes-service';
import { getPortfolioStore, type PortfolioStore } from '@/lib/portfolio-store';
import { getWorkspaceById } from '@/lib/workspace-store';
import { createLogger } from '@/lib/logger';

const log = createLogger('portfolio-runtime');

interface IPortfolioPassDeps {
  store: Pick<PortfolioStore, 'dueCheckpoints' | 'markEscalated' | 'escalationKey' | 'pendingWakes' | 'markWakeSent'>;
  now: () => number;
  coordinatorOf: (workspaceId: string) => Promise<string | null>;
  send: (workspaceId: string, input: { subject: string; body: string; externalKey: string }) => Promise<unknown>;
}

export const runPortfolioPass = async (deps: IPortfolioPassDeps): Promise<void> => {
  const now = deps.now();
  for (const impact of deps.store.dueCheckpoints(now)) {
    try {
      await deps.send(impact.workspaceId, {
        subject: `Portfolio checkpoint missed: ${impact.id}`,
        body: `Blocker ${impact.id} missed checkpoint ${impact.checkpointAt}. Read the current portfolio board for its latest state and clearing action. Report a new checkpoint or verified dependency proof; age alone never clears the blocker.`,
        externalKey: `portfolio:checkpoint:${deps.store.escalationKey(impact)}`,
      });
      deps.store.markEscalated(impact.id, impact.revision, now);
    } catch (error) {
      log.warn({ err: error, impactId: impact.id }, 'Portfolio checkpoint escalation deferred');
    }
  }
  for (const wake of deps.store.pendingWakes()) {
    try {
      const coordinatorId = await deps.coordinatorOf(wake.workspaceId);
      if (wake.source === 'capacity-claim') {
        const claim = JSON.parse(wake.claim!) as { observedAt: number };
        await deps.send(wake.workspaceId, {
          subject: `Portfolio capacity clearance claim: ${wake.resourceKey}`,
          body: `A shared capacity clearance claim was recorded for ${wake.resourceKey} at ${claim.observedAt}. Your release remains blocked until your coordinator checks and reports its own evidence. This claim does not verify deployment.`,
          externalKey: `portfolio:resolved:${wake.id}`,
        });
      } else if (wake.workspaceId !== wake.watchOwnerWorkspaceId || coordinatorId !== wake.watchOwnerTabId) {
        await deps.send(wake.workspaceId, {
          subject: `Portfolio dependency cleared: ${wake.resourceKey}`,
          body: `Harness watch ${wake.watchId} cleared dependency ${wake.resourceKey}. Re-evaluate this workspace's affected release and report its next verified milestone. This proof does not establish deployment or verification.`,
          externalKey: `portfolio:resolved:${wake.id}`,
        });
      }
      deps.store.markWakeSent(wake.id);
    } catch (error) {
      log.warn({ err: error, wakeId: wake.id }, 'Portfolio owner wake deferred');
    }
  }
};

const g = globalThis as unknown as { __ptPortfolioRuntime?: { timer: ReturnType<typeof setInterval>; running: Promise<void> | null } };

export const tickPortfolio = (): Promise<void> => {
  if (!g.__ptPortfolioRuntime) return Promise.resolve();
  if (g.__ptPortfolioRuntime.running) return g.__ptPortfolioRuntime.running;
  const runtime = g.__ptPortfolioRuntime;
  runtime.running = (async () => {
    const notes = await getNotesService();
    await runPortfolioPass({
      store: getPortfolioStore(), now: () => Date.now(),
      coordinatorOf: async (workspaceId) => {
        const orchestration = (await getWorkspaceById(workspaceId))?.orchestration;
        return orchestration?.enabled ? orchestration.orchestratorTabId ?? null : null;
      },
      send: (workspaceId, input) => notes.sendSystemLocal(workspaceId, input),
    });
  })().finally(() => { runtime.running = null; });
  return runtime.running;
};

export const startPortfolioRuntime = (): void => {
  if (g.__ptPortfolioRuntime) return;
  const timer = setInterval(() => {
    void tickPortfolio().catch((error) => log.warn({ err: error }, 'Portfolio notice pass failed'));
  }, 30_000);
  timer.unref?.();
  g.__ptPortfolioRuntime = { timer, running: null };
  void tickPortfolio().catch((error) => log.warn({ err: error }, 'Portfolio boot pass failed'));
};

export const stopPortfolioRuntime = async (): Promise<void> => {
  const runtime = g.__ptPortfolioRuntime;
  if (!runtime) return;
  clearInterval(runtime.timer);
  await runtime.running?.catch((error) => log.warn({ err: error }, 'Portfolio shutdown pass failed'));
  g.__ptPortfolioRuntime = undefined;
};
