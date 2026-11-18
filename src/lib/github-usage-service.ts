import { execFile } from 'child_process';
import { ghCallsDir, readTabGhCalls } from '@/lib/gh-tab-calls';
import { installGhShim, installedGhShimDir, withoutGhShimDir } from '@/lib/gh-shim';
import { GH_TIMEOUT_MS } from '@/lib/gh-api';
import { GITHUB_AGENT_ACCOUNTS_KEY, QUOTA_READ_MS, readGithubQuotas, type IGhRun, type IQuotaDeps, type IQuotaRead } from '@/lib/github-quota';
import { createQuotaAlertState, runQuotaAlerts, type IQuotaAlertDeps, type IQuotaAlertState } from '@/lib/github-quota-alert';
import { buildGithubUsageView, countedRestSince, topOwnersLastHour, type IGithubUsageView, type IUsageDeps, type IWorkspaceNames } from '@/lib/github-usage';
import { serverGhLedger } from '@/lib/github-usage-ledger';
import { createLogger } from '@/lib/logger';

// The GitHub usage runtime: the shim installed at start, the quota read every 5 minutes with its alert, and the
// usage view the CLI route serves. State is on globalThis: the custom server and the API routes are one process.

const log = createLogger('github-usage');

/** The first quota read waits this long after the start, so a boot never waits on GitHub. */
const FIRST_READ_MS = 30_000;
/**
 * `gh auth status` validates every stored token with one API call each, the owner's too (measured: one request per
 * account). The server never reads that token, and keeps gh's use of it to one listing an hour.
 */
export const AUTH_STATUS_TTL_MS = 60 * 60_000;

interface IGithubUsageState {
  quota: IQuotaRead | null;
  shimReason: string | null;
  alerts: IQuotaAlertState;
  timer: ReturnType<typeof setInterval> | null;
  first: ReturnType<typeof setTimeout> | null;
  running: Promise<void> | null;
  authStatus: { at: number; run: IGhRun } | null;
}

const g = globalThis as unknown as { __ptGithubUsage?: IGithubUsageState };
const state = (): IGithubUsageState => {
  if (!g.__ptGithubUsage) {
    g.__ptGithubUsage = { quota: null, shimReason: null, alerts: createQuotaAlertState(), timer: null, first: null, running: null, authStatus: null };
  }
  return g.__ptGithubUsage;
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * One gh call of the server, counted in its ledger with no owner tab. GH_TOKEN and GITHUB_TOKEN of the server's own
 * environment are dropped, so `auth status` and `auth token` see the stored accounts; `env` is the call's own.
 */
const runGh = (args: string[], env: Record<string, string> = {}): Promise<IGhRun> => new Promise((resolve) => {
  const base: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
  delete base.GH_TOKEN;
  delete base.GITHUB_TOKEN;
  serverGhLedger().record(null, args, Date.now());
  execFile('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 1024 * 1024, env: { ...base, ...env } }, (err, stdout, stderr) => {
    resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') });
  });
});

/** The account listing, reused for an hour after a good answer; a failed one is asked again at the next read. */
const authStatus = async (now: number): Promise<IGhRun> => {
  const s = state();
  if (s.authStatus && now - s.authStatus.at < AUTH_STATUS_TTL_MS) return s.authStatus.run;
  const run = await runGh(['auth', 'status']);
  s.authStatus = run.ok ? { at: now, run } : null;
  return run;
};

const quotaDeps = (): IQuotaDeps => ({
  now: Date.now,
  gh: (args, env) => (args.length === 2 && args[0] === 'auth' && args[1] === 'status' ? authStatus(Date.now()) : runGh(args, env)),
  agentAccounts: async () => {
    const { readFleetConfig, valueOf } = await import('@/lib/fleet-config-store');
    return valueOf(await readFleetConfig(), GITHUB_AGENT_ACCOUNTS_KEY)?.value ?? null;
  },
});

const readNames = async (): Promise<Map<string, IWorkspaceNames>> => {
  const [{ getWorkspaces }, { collectAllTabs, readLayoutFile, resolveLayoutFile }] = await Promise.all([
    import('@/lib/workspace-store'), import('@/lib/layout-store'),
  ]);
  const names = new Map<string, IWorkspaceNames>();
  for (const ws of (await getWorkspaces()).workspaces) {
    const layout = await readLayoutFile(resolveLayoutFile(ws.id)).catch(() => null);
    const tabs = new Map((layout ? collectAllTabs(layout.root) : []).map((t) => [t.id, t.name] as const));
    names.set(ws.id, { name: ws.name, tabs });
  }
  return names;
};

const usageDeps = (): IUsageDeps => ({
  now: Date.now,
  ledger: serverGhLedger,
  tabCalls: (now) => readTabGhCalls(ghCallsDir(), now),
  quota: () => state().quota,
  names: () => readNames().catch((err) => {
    log.warn(`github usage: names unreadable, ids shown (${errorText(err)})`);
    return new Map();
  }),
  shim: () => (installedGhShimDir() ? { installed: true, reason: null } : { installed: false, reason: state().shimReason ?? 'not installed by this server' }),
  tabCallsDir: () => ghCallsDir(),
});

const alertDeps = (): IQuotaAlertDeps => ({
  scrumMaster: async () => (await import('@/lib/portfolio-store')).getPortfolioStore().currentSelection()?.selection ?? null,
  workspaces: async () => (await (await import('@/lib/workspace-store')).getWorkspaces()).workspaces,
  routeTabEvent: async (event) => (await import('@/lib/status-manager')).getStatusManager().routeTabEvent(event),
  topOwners: () => topOwnersLastHour(usageDeps()),
  countedRestSince: (from) => countedRestSince(usageDeps(), from),
});

/** One quota read and its alert step; skipped while the previous one runs. */
export const runGithubQuotaTick = async (deps: IQuotaDeps = quotaDeps(), alerts: IQuotaAlertDeps = alertDeps()): Promise<void> => {
  const s = state();
  if (s.running) return;
  s.running = (async () => {
    const read = await readGithubQuotas(deps);
    s.quota = read;
    if (read.error) log.warn(read.error);
    await runQuotaAlerts(alerts, s.alerts, read.accounts, deps.now());
  })().catch((err) => {
    log.warn(`github quota read failed: ${errorText(err)}`);
  }).finally(() => {
    s.running = null;
  });
  await s.running;
};

/**
 * At server start: install the shim (no real gh: none, and no tab PATH changes), drop the shim directory from the
 * server's own PATH so its calls are counted once, by the ledger, and start the 5-minute quota read.
 */
export const startGithubUsage = async (): Promise<void> => {
  const s = state();
  serverGhLedger();
  process.env.PATH = withoutGhShimDir(process.env.PATH ?? '');
  try {
    const result = await installGhShim({ pathEnv: process.env.PATH });
    s.shimReason = result.installed ? null : result.reason;
    if (result.installed) log.info({ dir: result.dir, realGh: result.realGh }, 'gh shim installed');
    else log.warn(`gh shim not installed: ${result.reason}; tab gh calls are not counted`);
  } catch (err) {
    s.shimReason = `install failed: ${errorText(err)}`;
    log.warn(`gh shim not installed: ${errorText(err)}`);
  }
  if (s.timer) return;
  s.first = setTimeout(() => void runGithubQuotaTick(), FIRST_READ_MS);
  s.first.unref?.();
  s.timer = setInterval(() => void runGithubQuotaTick(), QUOTA_READ_MS);
  s.timer.unref?.();
};

export const stopGithubUsage = async (): Promise<void> => {
  const s = state();
  if (s.first) clearTimeout(s.first);
  if (s.timer) clearInterval(s.timer);
  s.first = null;
  s.timer = null;
  await s.running?.catch(() => undefined);
};

export const getGithubUsageView = (): Promise<IGithubUsageView> => buildGithubUsageView(usageDeps());
