import type { NextApiRequest, NextApiResponse } from 'next';
import { getConfig, updateConfig, hashPassword, generateSecret } from '@/lib/config-store';
import type { IConfigData } from '@/lib/config-store';
import type { TNetworkAccess } from '@/lib/network-access';
import { isBoundToLocalhostOnly, updateAccessFromConfig } from '@/lib/access-filter';
import { isValidEditorPreset } from '@/lib/editor-url';
import { isValidToastPosition } from '@/lib/toast-position';

const ALLOWED_FIELDS: (keyof Omit<IConfigData, 'updatedAt' | 'authSecret'>)[] = [
  'appTheme', 'terminalTheme', 'customCSS', 'dangerouslySkipPermissions', 'claudeShowTerminal', 'gitAskProvider', 'noteSummaryProvider', 'editorUrl', 'editorPreset', 'authPassword', 'notificationsEnabled', 'alertsOrchestratorOnly', 'toastOnCompleteEnabled', 'toastDuration', 'toastPositionDesktop', 'toastPositionMobile', 'locale', 'fontSize', 'lineHeight', 'lineHeightCustom', 'terminalKeyBar', 'systemResourcesEnabled', 'networkAccess',
];

const NETWORK_ACCESS_VALUES = ['localhost', 'tailscale', 'all'] as const;
const isValidNetworkAccess = (value: unknown): boolean =>
  typeof value === 'string' && (NETWORK_ACCESS_VALUES as readonly string[]).includes(value);

const GIT_ASK_PROVIDER_VALUES = ['claude', 'codex'] as const;
const isValidGitAskProvider = (value: unknown): boolean =>
  typeof value === 'string' && (GIT_ASK_PROVIDER_VALUES as readonly string[]).includes(value);

const NOTE_SUMMARY_PROVIDER_VALUES = ['claude', 'codex'] as const;
const isValidNoteSummaryProvider = (value: unknown): boolean =>
  typeof value === 'string' && (NOTE_SUMMARY_PROVIDER_VALUES as readonly string[]).includes(value);

const isValidEditorUrl = (value: unknown): value is string =>
  typeof value === 'string';

const isValidToastDuration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 1000 && value <= 60_000;

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method === 'GET') {
    const { authPassword, authSecret: _, ...safe } = await getConfig();
    const hostEnvLocked = typeof process.env.HOST === 'string' && process.env.HOST.trim().length > 0;
    return res.status(200).json({
      ...safe,
      hasAuthPassword: !!authPassword,
      hostEnvLocked,
      bindHostIsLocal: isBoundToLocalhostOnly(),
    });
  }

  if (req.method === 'PATCH') {
    const body = req.body ?? {};
    const updates: Record<string, unknown> = {};
    for (const key of ALLOWED_FIELDS) {
      if (key in body) updates[key] = body[key];
    }

    if ('editorUrl' in updates && !isValidEditorUrl(updates.editorUrl)) {
      return res.status(400).json({ error: 'editorUrl must be a string.' });
    }

    if ('editorPreset' in updates && !isValidEditorPreset(updates.editorPreset)) {
      return res.status(400).json({ error: 'editorPreset is invalid.' });
    }

    if ('networkAccess' in updates && !isValidNetworkAccess(updates.networkAccess)) {
      return res.status(400).json({ error: 'networkAccess must be one of: localhost, tailscale, all.' });
    }

    if ('gitAskProvider' in updates && !isValidGitAskProvider(updates.gitAskProvider)) {
      return res.status(400).json({ error: 'gitAskProvider must be one of: claude, codex.' });
    }

    if ('noteSummaryProvider' in updates && !isValidNoteSummaryProvider(updates.noteSummaryProvider)) {
      return res.status(400).json({ error: 'noteSummaryProvider must be one of: claude, codex.' });
    }

    if ('toastPositionDesktop' in updates && !isValidToastPosition(updates.toastPositionDesktop)) {
      return res.status(400).json({ error: 'toastPositionDesktop is invalid.' });
    }

    if ('toastPositionMobile' in updates && !isValidToastPosition(updates.toastPositionMobile)) {
      return res.status(400).json({ error: 'toastPositionMobile is invalid.' });
    }

    if ('toastDuration' in updates && !isValidToastDuration(updates.toastDuration)) {
      return res.status(400).json({ error: 'toastDuration must be a number between 1000 and 60000.' });
    }

    if ('alertsOrchestratorOnly' in updates && typeof updates.alertsOrchestratorOnly !== 'boolean') {
      return res.status(400).json({ error: 'alertsOrchestratorOnly must be a boolean.' });
    }

    if (typeof updates.authPassword === 'string' && updates.authPassword) {
      const hashed = await hashPassword(updates.authPassword as string);
      const secret = generateSecret();
      updates.authPassword = hashed;
      updates.authSecret = secret;

      await updateConfig(updates as Partial<Omit<IConfigData, 'updatedAt'>>);

      process.env.AUTH_PASSWORD = hashed;
      process.env.NEXTAUTH_SECRET = secret;
    } else {
      delete updates.authPassword;
      await updateConfig(updates as Partial<Omit<IConfigData, 'updatedAt'>>);
    }

    if ('networkAccess' in updates) {
      updateAccessFromConfig(updates.networkAccess as TNetworkAccess);
    }

    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, PATCH');
  return res.status(405).json({ error: 'Method not allowed' });
};

export default handler;
