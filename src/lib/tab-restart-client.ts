import type { IRestartTabAnswer } from '@/types/tab-restart';

export type TTabRestartOutcome =
  | { ok: true; answer: IRestartTabAnswer }
  /** `code` is the server's refusal code; null when the answer carried none (a read error, not a refusal). */
  | { ok: false; code: string | null; message: string };

/** `tab restart` from the web tab menu, through the cookie route (ADR-0028). */
export const requestTabRestart = async (
  workspaceId: string,
  tabId: string,
  body: { clear: boolean; interrupt: boolean },
): Promise<TTabRestartOutcome> => {
  let res: Response;
  try {
    res = await fetch(`/api/tabs/${encodeURIComponent(tabId)}/restart?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, code: null, message: 'The server did not answer; whether the tab restarted is unknown' };
  }
  const data = await res.json().catch(() => null) as Record<string, unknown> | null;
  if (res.ok && data?.ok === true) return { ok: true, answer: data as unknown as IRestartTabAnswer };
  return {
    ok: false,
    code: typeof data?.code === 'string' ? data.code : null,
    message: typeof data?.error === 'string' ? data.error : `The restart failed (HTTP ${res.status})`,
  };
};
