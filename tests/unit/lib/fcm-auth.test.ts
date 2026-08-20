import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { importSPKI, jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
  FCM_SCOPE,
  FCM_TOKEN_URL,
  createAccessTokenProvider,
  loadServiceAccount,
  parseServiceAccount,
} from '@/lib/fcm-auth';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const serviceAccountJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'service_account',
    project_id: 'pmux-alerts',
    client_email: 'alerts@pmux-alerts.iam.gserviceaccount.com',
    private_key: privateKey,
    ...overrides,
  });

const account = () => {
  const result = parseServiceAccount(serviceAccountJson());
  if (!result.ok) throw new Error(result.reason);
  return result.account;
};

const tokenResponse = (token: string, expiresIn = 3600) => ({
  ok: true,
  status: 200,
  json: async () => ({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' }),
});

describe('parseServiceAccount', () => {
  it('reads the three fields FCM needs off a service-account key file', () => {
    const result = parseServiceAccount(serviceAccountJson());

    expect(result).toEqual({
      ok: true,
      account: {
        projectId: 'pmux-alerts',
        clientEmail: 'alerts@pmux-alerts.iam.gserviceaccount.com',
        privateKey,
      },
    });
  });

  it('names the missing field without quoting the file', () => {
    const result = parseServiceAccount(serviceAccountJson({ project_id: undefined }));

    expect(result).toEqual({ ok: false, reason: 'missing project_id' });
  });

  it('rejects a private_key that is not a PKCS8 PEM block', () => {
    const result = parseServiceAccount(serviceAccountJson({ private_key: 'AAAA-not-a-pem' }));

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('private_key is not a PKCS8 PEM block');
  });

  it('never echoes file content in the reason for malformed JSON', () => {
    const result = parseServiceAccount(`{ "private_key": "${privateKey.slice(0, 80)}`);

    expect(result).toEqual({ ok: false, reason: 'malformed-json' });
  });
});

describe('loadServiceAccount', () => {
  it('distinguishes an absent file from an unreadable one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-fcm-auth-'));

    expect(loadServiceAccount(path.join(dir, 'missing.json'))).toEqual({ ok: false, reason: 'not-found' });

    const unreadable = path.join(dir, 'dir-not-file.json');
    fs.mkdirSync(unreadable);
    const result = loadServiceAccount(unreadable);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/^unreadable \(/);
  });

  it('parses a readable key file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-fcm-auth-'));
    const file = path.join(dir, 'sa.json');
    fs.writeFileSync(file, serviceAccountJson());

    const result = loadServiceAccount(file);

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.account.projectId).toBe('pmux-alerts');
  });
});

describe('createAccessTokenProvider', () => {
  it('signs a JWT bearer assertion the Google token endpoint would accept', async () => {
    let sent: { url: string; body: string } | null = null;
    const provider = createAccessTokenProvider(account(), {
      fetchImpl: async (url, init) => {
        sent = { url, body: init.body };
        return tokenResponse('ya29.first');
      },
      now: () => 1_700_000_000_000,
    });

    expect(await provider()).toBe('ya29.first');
    expect(sent!.url).toBe(FCM_TOKEN_URL);

    const form = new URLSearchParams(sent!.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const { payload, protectedHeader } = await jwtVerify(
      form.get('assertion')!,
      await importSPKI(publicKey, 'RS256'),
      {
        audience: FCM_TOKEN_URL,
        issuer: 'alerts@pmux-alerts.iam.gserviceaccount.com',
        currentDate: new Date(1_700_000_000_000),
      },
    );
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload.sub).toBe('alerts@pmux-alerts.iam.gserviceaccount.com');
    expect(payload.scope).toBe(FCM_SCOPE);
    expect(payload.iat).toBe(1_700_000_000);
    expect(payload.exp).toBe(1_700_000_000 + 3600);
  });

  it('caches the token until it is close to expiry, then mints a new one', async () => {
    let clock = 1_700_000_000_000;
    let minted = 0;
    const provider = createAccessTokenProvider(account(), {
      fetchImpl: async () => {
        minted += 1;
        return tokenResponse(`ya29.${minted}`, 3600);
      },
      now: () => clock,
    });

    expect(await provider()).toBe('ya29.1');
    clock += 3_000_000;
    expect(await provider()).toBe('ya29.1');
    expect(minted).toBe(1);

    clock += 600_000;
    expect(await provider()).toBe('ya29.2');
    expect(minted).toBe(2);
  });

  it('collapses concurrent callers onto a single mint', async () => {
    const fetchImpl = vi.fn(async () => tokenResponse('ya29.shared'));
    const provider = createAccessTokenProvider(account(), { fetchImpl, now: () => 1_700_000_000_000 });

    const tokens = await Promise.all([provider(), provider(), provider()]);

    expect(tokens).toEqual(['ya29.shared', 'ya29.shared', 'ya29.shared']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports only the HTTP status when the token endpoint rejects the assertion', async () => {
    const provider = createAccessTokenProvider(account(), {
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_grant', error_description: privateKey }),
      }),
      now: () => 1_700_000_000_000,
    });

    await expect(provider()).rejects.toThrow('FCM token request failed: 401');
    await provider().catch((err: Error) => {
      expect(err.message).not.toContain('PRIVATE KEY');
      expect(err.message).not.toContain('invalid_grant');
    });
  });

  it('retries the mint after a failure instead of caching the rejection', async () => {
    let attempt = 0;
    const provider = createAccessTokenProvider(account(), {
      fetchImpl: async () => {
        attempt += 1;
        return attempt === 1 ? { ok: false, status: 503, json: async () => ({}) } : tokenResponse('ya29.recovered');
      },
      now: () => 1_700_000_000_000,
    });

    await expect(provider()).rejects.toThrow('FCM token request failed: 503');
    expect(await provider()).toBe('ya29.recovered');
  });

  it('rejects a 200 response with no access_token', async () => {
    const provider = createAccessTokenProvider(account(), {
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ expires_in: 3600 }) }),
      now: () => 1_700_000_000_000,
    });

    await expect(provider()).rejects.toThrow('FCM token response carried no access_token');
  });
});
