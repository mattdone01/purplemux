import type { IGrant, IGrantee } from '@/types/grant';

// The web client of the grant routes (story 28; ADR-0014). Same-origin fetch:
// the session cookie goes with it, and the server checks the Origin. A failure
// keeps the SERVED reason and code, so the dialog never shows a generic error.

export interface IGrantsView {
  grants: IGrant[];
  grantees: IGrantee[];
}

export type TGrantCall<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string | null; reason: string | null };

const call = async <T>(url: string, init: RequestInit, pick: (body: Record<string, unknown>) => T): Promise<TGrantCall<T>> => {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    return { ok: false, status: 0, code: null, reason: err instanceof Error ? err.message : String(err) };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (res.ok && body) return { ok: true, value: pick(body) };
  return {
    ok: false,
    status: res.status,
    code: typeof body?.code === 'string' ? body.code : null,
    reason: typeof body?.error === 'string' ? body.error : null,
  };
};

export const fetchGrantsView = (): Promise<TGrantCall<IGrantsView>> =>
  call('/api/grants', { method: 'GET' }, (b) => ({
    grants: Array.isArray(b.grants) ? (b.grants as IGrant[]) : [],
    grantees: Array.isArray(b.grantees) ? (b.grantees as IGrantee[]) : [],
  }));

export interface ICreateGrantForm {
  granteeWorkspaceId: string;
  granteeTabId: string;
  workspaces: string[];
  reason: string;
  expiresInHours: number;
  password: string;
}

export const createGrantRequest = (form: ICreateGrantForm): Promise<TGrantCall<IGrant>> =>
  call('/api/grants', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) }, (b) => b.grant as IGrant);

export const revokeGrantRequest = (id: string): Promise<TGrantCall<IGrant>> =>
  call(`/api/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }, (b) => b.grant as IGrant);
