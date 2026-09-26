import fs from 'fs/promises';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { ILayoutData, IWorkspace } from '@/types/terminal';

type THandler = (req: NextApiRequest, res: NextApiResponse) => unknown;

export interface IRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
}

/** Calls a Next API handler the way the pages router would, without a server. */
export const callRoute = async (
  handler: THandler,
  init: { method: string; headers?: Record<string, string>; query?: Record<string, string>; body?: unknown },
): Promise<IRouteResult> => {
  const state: IRouteResult = { status: 0, body: {}, headers: {} };
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const res = {
    status(code: number) { state.status = code; return res; },
    json(payload: Record<string, unknown>) { state.body = payload; done(); return res; },
    setHeader(name: string, value: unknown) { state.headers[name] = value; return res; },
    end() { done(); return res; },
  } as unknown as NextApiResponse;
  const req = {
    method: init.method,
    headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    query: init.query ?? {},
    body: init.body,
  } as unknown as NextApiRequest;
  await handler(req, res);
  await finished;
  return state;
};

/** The lease routes behind a real HTTP port, so the installed CLI can be run against them. */
export const serveLeaseRoutes = async (routes: Record<string, THandler>): Promise<{ port: number; close: () => Promise<void> }> => {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const handler = routes[url.pathname];
      if (!handler) {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html>404</html>');
        return;
      }
      const result = await callRoute(handler, {
        method: req.method ?? 'GET',
        headers: Object.fromEntries(Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === 'string')),
        query: Object.fromEntries(url.searchParams.entries()),
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export const loadLeaseRoutes = async (): Promise<Record<string, THandler>> => ({
  '/api/cli/leases': (await import('@/pages/api/cli/leases/index')).default,
  '/api/cli/leases/check': (await import('@/pages/api/cli/leases/check')).default,
  '/api/cli/leases/acquire': (await import('@/pages/api/cli/leases/acquire')).default,
  '/api/cli/leases/renew': (await import('@/pages/api/cli/leases/renew')).default,
  '/api/cli/leases/release': (await import('@/pages/api/cli/leases/release')).default,
  '/api/cli/leases/break': (await import('@/pages/api/cli/leases/break')).default,
  '/api/cli/leases/release-epic': (await import('@/pages/api/cli/leases/release-epic')).default,
});

export interface IFixtureTab {
  id: string;
  name: string;
}

/** workspaces.json plus one layout per workspace, as a running server leaves them. */
export const writeFixture = async (
  home: string,
  workspaces: Array<{ id: string; name: string; tabs: IFixtureTab[]; orchestratorTabId?: string }>,
): Promise<void> => {
  const base = path.join(home, '.purplemux');
  const list: IWorkspace[] = workspaces.map((ws) => ({
    id: ws.id,
    name: ws.name,
    directories: [home],
    ...(ws.orchestratorTabId ? { orchestration: { enabled: true, orchestratorTabId: ws.orchestratorTabId } } : {}),
  }));
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, 'workspaces.json'), JSON.stringify({
    workspaces: list, groups: [], sidebarCollapsed: false, sidebarWidth: 240, updatedAt: '2026-09-26T00:00:00.000Z',
  }));
  for (const ws of workspaces) {
    const layout: ILayoutData = {
      root: {
        type: 'pane',
        id: 'pane-1',
        activeTabId: ws.tabs[0]?.id ?? null,
        tabs: ws.tabs.map((t, order) => ({ id: t.id, name: t.name, order, sessionName: `pt-${ws.id}-pane-1-${t.id}` })),
      },
      activePaneId: 'pane-1',
      updatedAt: '2026-09-26T00:00:00.000Z',
    };
    await fs.mkdir(path.join(base, 'workspaces', ws.id), { recursive: true });
    await fs.writeFile(path.join(base, 'workspaces', ws.id, 'layout.json'), JSON.stringify(layout));
  }
};

export const LEASE_ROUTE_GLOBALS = [
  '__ptLeaseLock', '__ptLeaseListeners', '__ptLeaseSweeper', '__ptLeaseAgentStateSource', '__ptCoordinationAuditLock',
  '__ptTabLifecycle', '__ptTabTokens', '__ptTabTokenLock', '__ptTabTokenRevokeInstalled', '__ptWorkspaceTokens',
  '__ptCliToken', '__purplemuxWorkspaceLock', '__purplemuxWorkspacesContentCache', '__ptLayoutContentCache', '__ptLayoutLock',
];

export const resetRouteGlobals = (): void => {
  const g = globalThis as Record<string, unknown>;
  for (const key of LEASE_ROUTE_GLOBALS) delete g[key];
};

export const drainRouteLocks = async (): Promise<void> => {
  const g = globalThis as unknown as Record<string, Promise<void> | undefined>;
  await g.__ptLeaseLock;
  await g.__ptCoordinationAuditLock;
  await g.__ptTabTokenLock;
};
