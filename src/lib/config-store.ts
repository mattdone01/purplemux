import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { broadcastSync } from '@/lib/sync-server';
import { createLogger } from '@/lib/logger';
import type { TNetworkAccess } from '@/lib/network-access';
import type { TEditorPreset } from '@/lib/editor-url';
import type { TToastPosition } from '@/lib/toast-position';

export type TAgentProvider = 'claude' | 'codex';
export type TGitAskProvider = TAgentProvider;
export type TNoteSummaryProvider = TAgentProvider;

const log = createLogger('config');

export interface IConfigData {
  authPassword?: string;
  authSecret?: string;
  appTheme?: string;
  terminalTheme?: { light: string; dark: string };
  customCSS?: string;
  dangerouslySkipPermissions?: boolean;
  claudeShowTerminal?: boolean;
  gitAskProvider?: TGitAskProvider;
  noteSummaryProvider?: TNoteSummaryProvider;
  editorUrl?: string;
  editorPreset?: TEditorPreset;
  notificationsEnabled?: boolean;
  // Default true (ALERTS_ORCHESTRATOR_ONLY_DEFAULT in lib/alert-policy.ts): only
  // the orchestrator tab of an orchestrated workspace raises an alert.
  alertsOrchestratorOnly?: boolean;
  toastOnCompleteEnabled?: boolean;
  toastDuration?: number;
  toastPositionDesktop?: TToastPosition;
  toastPositionMobile?: TToastPosition;
  locale?: string;
  fontSize?: string;
  lineHeight?: string;
  lineHeightCustom?: number;
  terminalKeyBar?: 'auto' | 'always' | 'never';
  systemResourcesEnabled?: boolean;
  networkAccess?: TNetworkAccess;
  updatedAt: string;
}

const BASE_DIR = path.join(os.homedir(), '.purplemux');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');

const g = globalThis as unknown as {
  __ptConfigLock?: Promise<void>;
  __ptConfigContentCache?: string;
};
if (!g.__ptConfigLock) g.__ptConfigLock = Promise.resolve();

const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  let release: () => void;
  const next = new Promise<void>((r) => {
    release = r;
  });
  const prev = g.__ptConfigLock!;
  g.__ptConfigLock = next;
  await prev;
  try {
    return await fn();
  } finally {
    release!();
  }
};

const emptyConfig = (): IConfigData => ({
  updatedAt: new Date().toISOString(),
});

export const readConfig = async (): Promise<IConfigData | null> => {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as IConfigData;
  } catch {
    return null;
  }
};

export const writeConfig = async (data: IConfigData): Promise<void> => {
  const { updatedAt: _, ...rest } = data;
  const contentKey = JSON.stringify(rest);
  if (g.__ptConfigContentCache === contentKey) return;

  data.updatedAt = new Date().toISOString();
  const tmpFile = CONFIG_FILE + '.tmp';
  try {
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
    await fs.rename(tmpFile, CONFIG_FILE);
  } catch (err) {
    await fs.unlink(tmpFile).catch(() => {});
    throw err;
  }

  g.__ptConfigContentCache = contentKey;
  broadcastSync({ type: 'config' });
};

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;
const SCRYPT_PREFIX = 'scrypt:';

export const MIN_PASSWORD_LENGTH = 4;

export const isHashedPassword = (value: string | undefined | null): boolean =>
  typeof value === 'string' && value.startsWith(SCRYPT_PREFIX);

export const hashPassword = async (plain: string): Promise<string> => {
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(plain, salt, SCRYPT_KEYLEN, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return `${SCRYPT_PREFIX}${salt.toString('hex')}:${derived.toString('hex')}`;
};

export const verifyPassword = async (plain: string, stored: string): Promise<boolean> => {
  if (!isHashedPassword(stored)) return false;
  const [, saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(plain, salt, expected.length, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
  return crypto.timingSafeEqual(derived, expected);
};

export const getConfig = async (): Promise<IConfigData> => {
  const data = await readConfig();
  return data ?? emptyConfig();
};

export const updateConfig = async (updates: Partial<Omit<IConfigData, 'updatedAt'>>): Promise<void> =>
  withLock(async () => {
    const data = (await readConfig()) ?? emptyConfig();
    Object.assign(data, updates);
    await writeConfig(data);
  });

export const needsSetup = async (): Promise<boolean> => {
  const data = await readConfig();
  return !isHashedPassword(data?.authPassword);
};

export const initConfigStore = async (): Promise<void> => {
  await fs.mkdir(BASE_DIR, { recursive: true });

  const existing = await readConfig();
  if (existing) {
    log.debug('config.json loaded');
    return;
  }

  await writeConfig(emptyConfig());
  log.info('Initial config.json created (onboarding required)');
};

export const getDangerouslySkipPermissions = async (): Promise<boolean> => {
  const data = await readConfig();
  return data?.dangerouslySkipPermissions ?? false;
};

export const generateSecret = (): string =>
  crypto.randomBytes(32).toString('hex');
