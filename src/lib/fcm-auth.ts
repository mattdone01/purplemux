import fs from 'fs';
import { SignJWT, importPKCS8 } from 'jose';

export const FCM_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

const JWT_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const ASSERTION_LIFETIME_SEC = 3600;
const EXPIRY_SKEW_MS = 60_000;
const PKCS8_HEADER = '-----BEGIN PRIVATE KEY-----';

export interface IFcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export type TServiceAccountResult =
  | { ok: true; account: IFcmServiceAccount }
  | { ok: false; reason: string };

export interface IFcmTokenResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type TFcmFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<IFcmTokenResponse>;

export interface IAccessTokenDeps {
  fetchImpl: TFcmFetch;
  now: () => number;
}

/**
 * Every failure here becomes a log line, so no reason may quote file content —
 * a service-account key file is nothing but key material and a JSON parse error
 * would echo the bytes it choked on.
 */
export const parseServiceAccount = (raw: string): TServiceAccountResult => {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  if (typeof json !== 'object' || json === null) return { ok: false, reason: 'malformed-json' };

  for (const field of ['project_id', 'client_email', 'private_key']) {
    const value = json[field];
    if (typeof value !== 'string' || !value) return { ok: false, reason: `missing ${field}` };
  }
  const privateKey = json.private_key as string;
  if (!privateKey.includes(PKCS8_HEADER)) {
    return { ok: false, reason: 'private_key is not a PKCS8 PEM block' };
  }

  return {
    ok: true,
    account: {
      projectId: json.project_id as string,
      clientEmail: json.client_email as string,
      privateKey,
    },
  };
};

export const loadServiceAccount = (filePath: string): TServiceAccountResult => {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === 'ENOENT' ? 'not-found' : `unreadable (${code ?? 'unknown'})` };
  }
  return parseServiceAccount(raw);
};

/**
 * Mints Google OAuth2 access tokens from the service account and caches one
 * until it is within `EXPIRY_SKEW_MS` of expiry. Concurrent callers share the
 * in-flight mint so a burst of alerts costs one token request, not one each.
 */
export const createAccessTokenProvider = (
  account: IFcmServiceAccount,
  overrides: Partial<IAccessTokenDeps> = {},
): (() => Promise<string>) => {
  const deps: IAccessTokenDeps = {
    fetchImpl: (url, init) => fetch(url, init),
    now: Date.now,
    ...overrides,
  };

  let signingKey: ReturnType<typeof importPKCS8> | null = null;
  let cached: { token: string; expiresAt: number } | null = null;
  let inflight: Promise<string> | null = null;

  const mint = async (): Promise<string> => {
    if (!signingKey) signingKey = importPKCS8(account.privateKey, 'RS256');
    const issuedAt = Math.floor(deps.now() / 1000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(account.clientEmail)
      .setSubject(account.clientEmail)
      .setAudience(FCM_TOKEN_URL)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ASSERTION_LIFETIME_SEC)
      .sign(await signingKey);

    const res = await deps.fetchImpl(FCM_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: JWT_GRANT_TYPE, assertion }).toString(),
    });
    // The status alone: a token-endpoint error body echoes the assertion back.
    if (!res.ok) throw new Error(`FCM token request failed: ${res.status}`);

    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('FCM token response carried no access_token');
    }
    const lifetime = typeof body.expires_in === 'number' ? body.expires_in : ASSERTION_LIFETIME_SEC;
    cached = { token: body.access_token, expiresAt: deps.now() + lifetime * 1000 };
    return cached.token;
  };

  return async (): Promise<string> => {
    if (cached && cached.expiresAt - EXPIRY_SKEW_MS > deps.now()) return cached.token;
    if (!inflight) {
      inflight = mint().finally(() => { inflight = null; });
    }
    return inflight;
  };
};
