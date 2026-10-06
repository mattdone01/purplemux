import { sendWebPrompt } from '@/lib/web-prompt-client';
import { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import type { TCliState } from '@/types/timeline';
import { isCliIdle } from '@/hooks/use-tab-store';

type TWebInputMode = 'input' | 'interrupt' | 'disabled';

const RESTART_COMMANDS = new Set(['/new', '/clear']);
const DRAFT_KEY_PREFIX = 'pt-input-draft:';

const getDraftKey = (tabId: string) => `${DRAFT_KEY_PREFIX}${tabId}`;

const saveDraft = (tabId: string, value: string) => {
  try {
    if (value) {
      localStorage.setItem(getDraftKey(tabId), value);
    } else {
      localStorage.removeItem(getDraftKey(tabId));
    }
  } catch {
    /* quota exceeded 등 무시 */
  }
};

const loadDraft = (tabId: string): string => {
  try {
    return localStorage.getItem(getDraftKey(tabId)) ?? '';
  } catch {
    return '';
  }
};

const clearDraft = (tabId: string) => {
  try {
    localStorage.removeItem(getDraftKey(tabId));
  } catch {
    /* ignore */
  }
};

interface IUseWebInputReturn {
  value: string;
  setValue: (v: string) => void;
  mode: TWebInputMode;
  canSend: boolean;
  send: () => Promise<void>;
  interrupt: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  focusInput: () => void;
}

interface IUseWebInputOptions {
  tabId?: string;
  onRestartSession?: () => void;
  onMessageSent?: (message: string) => void;
  disabledMessage?: string;
  workspaceId?: string;
  sessionName?: string;
}

const useWebInput = (
  cliState: TCliState,
  sendStdin: (data: string) => void,
  terminalWsConnected: boolean,
  options?: IUseWebInputOptions,
): IUseWebInputReturn => {
  const tabId = options?.tabId;
  const [value, setValue] = useState(() => (tabId ? loadDraft(tabId) : ''));
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mode: TWebInputMode = useMemo(() => {
    if (isCliIdle(cliState) || cliState === 'unknown') return 'input';
    if (cliState === 'busy' || cliState === 'needs-input') return 'interrupt';
    return 'disabled';
  }, [cliState]);

  const onRestartSession = options?.onRestartSession;
  const onMessageSent = options?.onMessageSent;
  const workspaceId = options?.workspaceId;
  const sessionName = options?.sessionName;
  const submitting = useRef(false);

  const draftTimerRef = useRef<ReturnType<typeof setTimeout>>(null);
  useEffect(() => {
    if (!tabId) return;
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => saveDraft(tabId, value), 300);
    return () => {
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current);
    };
  }, [tabId, value]);

  const send = useCallback(async () => {
    if (submitting.current) return;
    if (mode === 'disabled') {
      toast.error(options?.disabledMessage ?? t('terminal', 'inputDisabledPlaceholder'));
      return;
    }

    if (!terminalWsConnected) {
      toast.error(t('connection', 'terminalDisconnected'));
      return;
    }

    if (value.trim() === '') return;

    if (RESTART_COMMANDS.has(value.trim().toLowerCase())) {
      onRestartSession?.();
      setValue('');
      if (tabId) clearDraft(tabId);
      return;
    }

    submitting.current = true;
    try {
      await sendWebPrompt({ workspaceId, tabId, sessionName }, value);
      if (!value.trim().startsWith('/')) onMessageSent?.(value.trim());
      setValue('');
      if (tabId) clearDraft(tabId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Prompt delivery failed');
    } finally {
      submitting.current = false;
    }
  }, [mode, value, terminalWsConnected, onRestartSession, onMessageSent, tabId, workspaceId, sessionName, options?.disabledMessage]);

  const interrupt = useCallback(() => {
    if (!terminalWsConnected) {
      toast.error(t('connection', 'terminalDisconnected'));
      return;
    }
    sendStdin('\x1b\x1b');
  }, [sendStdin, terminalWsConnected]);

  const focusInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    el.setSelectionRange(len, len);
  }, []);

  const canSend = mode !== 'disabled' && terminalWsConnected;

  return {
    value,
    setValue,
    mode,
    canSend,
    send,
    interrupt,
    textareaRef,
    focusInput,
  };
};

export default useWebInput;
export { clearDraft as clearInputDraft };
export type { TWebInputMode };
