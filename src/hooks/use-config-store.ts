import { create } from 'zustand';
import type { TEditorPreset } from '@/lib/editor-url';
import type { TToastPosition } from '@/lib/toast-position';
import type { TGitAskProvider, TNoteSummaryProvider } from '@/lib/config-store';
import { DEFAULT_LINE_HEIGHT } from '@/lib/terminal-line-height';
import { ALERTS_ORCHESTRATOR_ONLY_DEFAULT } from '@/lib/alert-policy';

export type { TToastPosition } from '@/lib/toast-position';
export type { TGitAskProvider, TNoteSummaryProvider } from '@/lib/config-store';

export type TNetworkAccess = 'localhost' | 'tailscale' | 'all';
export type TTerminalKeyBar = 'auto' | 'always' | 'never';

export const DEFAULT_TOAST_DURATION = 10000;
export const DEFAULT_TOAST_POSITION_DESKTOP: TToastPosition = 'top-right';
export const DEFAULT_TOAST_POSITION_MOBILE: TToastPosition = 'top-center';

export interface IConfigInitialData {
  appTheme?: string | null;
  terminalTheme?: { light: string; dark: string } | null;
  customCSS?: string;
  dangerouslySkipPermissions?: boolean;
  claudeShowTerminal?: boolean;
  gitAskProvider?: TGitAskProvider;
  noteSummaryProvider?: TNoteSummaryProvider;
  editorUrl?: string;
  editorPreset?: TEditorPreset;
  notificationsEnabled?: boolean;
  alertsOrchestratorOnly?: boolean;
  toastOnCompleteEnabled?: boolean;
  toastDuration?: number;
  toastPositionDesktop?: TToastPosition;
  toastPositionMobile?: TToastPosition;
  hasAuthPassword?: boolean;
  locale?: string;
  fontSize?: string;
  lineHeight?: string;
  lineHeightCustom?: number;
  terminalKeyBar?: TTerminalKeyBar;
  systemResourcesEnabled?: boolean;
  networkAccess?: TNetworkAccess;
  hostEnvLocked?: boolean;
  bindHostIsLocal?: boolean;
}

interface IConfigState {
  dangerouslySkipPermissions: boolean;
  claudeShowTerminal: boolean;
  gitAskProvider: TGitAskProvider;
  noteSummaryProvider: TNoteSummaryProvider;
  editorUrl: string;
  editorPreset: TEditorPreset;
  notificationsEnabled: boolean;
  alertsOrchestratorOnly: boolean;
  toastOnCompleteEnabled: boolean;
  toastDuration: number;
  toastPositionDesktop: TToastPosition;
  toastPositionMobile: TToastPosition;
  hasAuthPassword: boolean;
  locale: string;
  customCSS: string;
  fontSize: string;
  lineHeight: string;
  lineHeightCustom: number;
  terminalKeyBar: TTerminalKeyBar;
  systemResourcesEnabled: boolean;
  networkAccess: TNetworkAccess;
  hostEnvLocked: boolean;
  bindHostIsLocal: boolean;

  hydrate: (data: IConfigInitialData) => void;
  setDangerouslySkipPermissions: (enabled: boolean) => void;
  setClaudeShowTerminal: (enabled: boolean) => void;
  setGitAskProvider: (provider: TGitAskProvider) => void;
  setNoteSummaryProvider: (provider: TNoteSummaryProvider) => void;
  setEditorUrl: (url: string) => void;
  setEditorPreset: (preset: TEditorPreset) => void;
  setNotificationsEnabled: (enabled: boolean) => void;
  setAlertsOrchestratorOnly: (enabled: boolean) => void;
  setToastOnCompleteEnabled: (enabled: boolean) => void;
  setToastDuration: (duration: number) => void;
  setToastPositionDesktop: (position: TToastPosition) => void;
  setToastPositionMobile: (position: TToastPosition) => void;
  changePassword: (password: string) => void;
  setLocale: (locale: string) => void;
  setCustomCSS: (css: string) => void;
  setFontSize: (fontSize: string) => void;
  setLineHeight: (lineHeight: string) => void;
  setLineHeightCustom: (value: number) => void;
  setTerminalKeyBar: (value: TTerminalKeyBar) => void;
  setSystemResourcesEnabled: (enabled: boolean) => void;
  setNetworkAccess: (value: TNetworkAccess) => void;
}

const initialConfig = {
  notificationsEnabled: true,
  alertsOrchestratorOnly: ALERTS_ORCHESTRATOR_ONLY_DEFAULT,
  toastOnCompleteEnabled: true,
  toastDuration: DEFAULT_TOAST_DURATION,
  toastPositionDesktop: DEFAULT_TOAST_POSITION_DESKTOP,
  toastPositionMobile: DEFAULT_TOAST_POSITION_MOBILE,
  editorUrl: '',
  editorPreset: 'code-server' as TEditorPreset,
  dangerouslySkipPermissions: false,
  claudeShowTerminal: true,
  gitAskProvider: 'claude' as TGitAskProvider,
  noteSummaryProvider: 'claude' as TNoteSummaryProvider,
  hasAuthPassword: false,
  locale: 'en',
  customCSS: '',
  fontSize: 'normal',
  lineHeight: 'normal',
  lineHeightCustom: DEFAULT_LINE_HEIGHT,
  terminalKeyBar: 'auto' as TTerminalKeyBar,
  systemResourcesEnabled: false,
  networkAccess: 'all' as TNetworkAccess,
  hostEnvLocked: false,
  bindHostIsLocal: false,
};

const saveConfig = (updates: Record<string, unknown>) => {
  fetch('/api/config', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  }).catch((err) => {
    console.log(`[config-store] update failed: ${err instanceof Error ? err.message : err}`);
  });
};

const useConfigStore = create<IConfigState>((set, get) => ({
  dangerouslySkipPermissions: initialConfig.dangerouslySkipPermissions,
  claudeShowTerminal: initialConfig.claudeShowTerminal,
  gitAskProvider: initialConfig.gitAskProvider,
  noteSummaryProvider: initialConfig.noteSummaryProvider,
  editorUrl: initialConfig.editorUrl,
  editorPreset: initialConfig.editorPreset,
  notificationsEnabled: initialConfig.notificationsEnabled,
  alertsOrchestratorOnly: initialConfig.alertsOrchestratorOnly,
  toastOnCompleteEnabled: initialConfig.toastOnCompleteEnabled,
  toastDuration: initialConfig.toastDuration,
  toastPositionDesktop: initialConfig.toastPositionDesktop,
  toastPositionMobile: initialConfig.toastPositionMobile,
  hasAuthPassword: initialConfig.hasAuthPassword,
  locale: initialConfig.locale,
  customCSS: initialConfig.customCSS,
  fontSize: initialConfig.fontSize,
  lineHeight: initialConfig.lineHeight,
  lineHeightCustom: initialConfig.lineHeightCustom,
  terminalKeyBar: initialConfig.terminalKeyBar,
  systemResourcesEnabled: initialConfig.systemResourcesEnabled,
  networkAccess: initialConfig.networkAccess,
  hostEnvLocked: initialConfig.hostEnvLocked,
  bindHostIsLocal: initialConfig.bindHostIsLocal,

  hydrate: (data) => {
    set({
      dangerouslySkipPermissions: data.dangerouslySkipPermissions ?? false,
      claudeShowTerminal: data.claudeShowTerminal ?? true,
      gitAskProvider: data.gitAskProvider === 'codex' ? 'codex' : 'claude',
      noteSummaryProvider: data.noteSummaryProvider === 'codex' ? 'codex' : 'claude',
      editorUrl: data.editorUrl ?? '',
      editorPreset: data.editorPreset ?? 'code-server',
      notificationsEnabled: data.notificationsEnabled ?? true,
      alertsOrchestratorOnly: data.alertsOrchestratorOnly ?? ALERTS_ORCHESTRATOR_ONLY_DEFAULT,
      toastOnCompleteEnabled: data.toastOnCompleteEnabled ?? true,
      toastDuration: data.toastDuration ?? DEFAULT_TOAST_DURATION,
      toastPositionDesktop: data.toastPositionDesktop ?? DEFAULT_TOAST_POSITION_DESKTOP,
      toastPositionMobile: data.toastPositionMobile ?? DEFAULT_TOAST_POSITION_MOBILE,
      hasAuthPassword: data.hasAuthPassword ?? false,
      locale: data.locale ?? 'en',
      customCSS: data.customCSS ?? '',
      fontSize: data.fontSize ?? 'normal',
      lineHeight: data.lineHeight ?? 'normal',
      lineHeightCustom: data.lineHeightCustom ?? DEFAULT_LINE_HEIGHT,
      terminalKeyBar: data.terminalKeyBar ?? 'auto',
      systemResourcesEnabled: data.systemResourcesEnabled ?? false,
      networkAccess: data.networkAccess ?? 'all',
      hostEnvLocked: data.hostEnvLocked ?? false,
      bindHostIsLocal: data.bindHostIsLocal ?? false,
    });
  },

  setDangerouslySkipPermissions: (enabled) => {
    set({ dangerouslySkipPermissions: enabled });
    saveConfig({ dangerouslySkipPermissions: enabled });
  },

  setClaudeShowTerminal: (enabled) => {
    set({ claudeShowTerminal: enabled });
    saveConfig({ claudeShowTerminal: enabled });
  },

  setGitAskProvider: (provider) => {
    set({ gitAskProvider: provider });
    saveConfig({ gitAskProvider: provider });
  },

  setNoteSummaryProvider: (provider) => {
    set({ noteSummaryProvider: provider });
    saveConfig({ noteSummaryProvider: provider });
  },

  setEditorUrl: (url) => {
    if (get().editorUrl === url) return;
    set({ editorUrl: url });
    saveConfig({ editorUrl: url });
  },

  setEditorPreset: (preset) => {
    if (get().editorPreset === preset) return;
    set({ editorPreset: preset });
    saveConfig({ editorPreset: preset });
  },

  setNotificationsEnabled: (enabled) => {
    set({ notificationsEnabled: enabled });
    saveConfig({ notificationsEnabled: enabled });
  },

  setAlertsOrchestratorOnly: (enabled) => {
    if (get().alertsOrchestratorOnly === enabled) return;
    set({ alertsOrchestratorOnly: enabled });
    saveConfig({ alertsOrchestratorOnly: enabled });
  },

  setToastOnCompleteEnabled: (enabled) => {
    if (get().toastOnCompleteEnabled === enabled) return;
    set({ toastOnCompleteEnabled: enabled });
    saveConfig({ toastOnCompleteEnabled: enabled });
  },

  setToastDuration: (duration) => {
    if (get().toastDuration === duration) return;
    set({ toastDuration: duration });
    saveConfig({ toastDuration: duration });
  },

  setToastPositionDesktop: (position) => {
    if (get().toastPositionDesktop === position) return;
    set({ toastPositionDesktop: position });
    saveConfig({ toastPositionDesktop: position });
  },

  setToastPositionMobile: (position) => {
    if (get().toastPositionMobile === position) return;
    set({ toastPositionMobile: position });
    saveConfig({ toastPositionMobile: position });
  },

  changePassword: (password) => {
    set({ hasAuthPassword: true });
    saveConfig({ authPassword: password });
  },

  setLocale: (locale) => {
    set({ locale });
    saveConfig({ locale });
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>).electronAPI) {
      (window as unknown as { electronAPI: { setLocale: (l: string) => void } }).electronAPI.setLocale(locale);
    }
  },

  setCustomCSS: (css) => {
    set({ customCSS: css });
    saveConfig({ customCSS: css });
  },

  setFontSize: (fontSize) => {
    set({ fontSize });
    saveConfig({ fontSize });
  },

  setLineHeight: (lineHeight) => {
    set({ lineHeight });
    saveConfig({ lineHeight });
  },

  setLineHeightCustom: (value) => {
    if (get().lineHeightCustom === value) return;
    set({ lineHeightCustom: value });
    saveConfig({ lineHeightCustom: value });
  },

  setTerminalKeyBar: (value) => {
    if (get().terminalKeyBar === value) return;
    set({ terminalKeyBar: value });
    saveConfig({ terminalKeyBar: value });
  },

  setSystemResourcesEnabled: (enabled) => {
    set({ systemResourcesEnabled: enabled });
    saveConfig({ systemResourcesEnabled: enabled });
  },

  setNetworkAccess: (value) => {
    set({ networkAccess: value });
    saveConfig({ networkAccess: value });
  },
}));

export default useConfigStore;
