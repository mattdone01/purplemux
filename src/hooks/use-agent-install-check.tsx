import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import InstallDialog from '@/components/features/login/install-dialog';
import CodexInstallGuideDialog from '@/components/features/login/codex-install-guide-dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { IRuntimePreflightResult } from '@/types/preflight';

export type TAgentInstallProvider = 'claude' | 'codex' | 'grok';

interface IInstallTarget {
  command: string;
  label: string;
}

interface IInstallPrompt {
  title: string;
  description: string;
  confirmLabel: string;
  action?: 'install' | 'guide';
  command?: string;
  label?: string;
}

const isInstalled = (status: IRuntimePreflightResult, provider: TAgentInstallProvider): boolean => {
  if (provider === 'codex') return status.codex.installed;
  if (provider === 'grok') return status.grok.installed;
  return status.claude.installed;
};

const fetchRuntimePreflight = async (): Promise<IRuntimePreflightResult | null> => {
  try {
    const res = await fetch('/api/preflight/runtime', { method: 'POST' });
    if (!res.ok) return null;
    return await res.json() as IRuntimePreflightResult;
  } catch {
    return null;
  }
};

export const useAgentInstallCheck = () => {
  const t = useTranslations('toolsRequired');
  const tc = useTranslations('common');
  const [installTarget, setInstallTarget] = useState<IInstallTarget | null>(null);
  const [codexGuideOpen, setCodexGuideOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<IInstallPrompt | null>(null);

  const ensureAgentInstalled = useCallback(async (provider: TAgentInstallProvider): Promise<boolean> => {
    const status = await fetchRuntimePreflight();
    if (!status) {
      setInstallPrompt({
        title: t('preflightFailedTitle'),
        description: t('preflightFailedDescription'),
        confirmLabel: tc('close'),
      });
      return false;
    }

    if (isInstalled(status, provider)) {
      // Grok Build signs in with browser OAuth and refuses to start a session
      // without it, so an installed-but-signed-out binary is the same blocker as
      // a missing one and gets its own hint.
      if (provider === 'grok' && !status.grok.loggedIn) {
        setInstallPrompt({
          title: t('grokNotLoggedInTitle'),
          description: t('grokNotLoggedInDescription'),
          confirmLabel: tc('close'),
        });
        return false;
      }
      return true;
    }

    if (provider === 'codex') {
      setInstallPrompt({
        title: t('codexMissingTitle'),
        description: t('codexMissingDescription'),
        confirmLabel: t('codexInstallGuide'),
        action: 'guide',
      });
      return false;
    }

    if (provider === 'grok') {
      setInstallPrompt({
        title: t('grokMissingTitle'),
        description: t('grokMissingDescription'),
        confirmLabel: tc('close'),
      });
      return false;
    }

    if (status.claude.binaryPath) {
      setInstallPrompt({
        title: t('agentPathPromptTitle'),
        description: t('agentPathPromptDescription'),
        confirmLabel: t('fixClaudePath'),
        action: 'install',
        command: 'claude-path',
        label: t('fixClaudePath'),
      });
      return false;
    }

    setInstallPrompt({
      title: t('agentInstallPromptTitle'),
      description: t('agentInstallPromptDescription'),
      confirmLabel: t('installClaude'),
      action: 'install',
      command: 'claude',
      label: t('installClaude'),
    });
    return false;
  }, [t, tc]);

  const handlePromptConfirm = useCallback(() => {
    if (!installPrompt?.action) {
      setInstallPrompt(null);
      return;
    }

    if (installPrompt.action === 'guide') {
      setInstallPrompt(null);
      setCodexGuideOpen(true);
      return;
    }

    if (installPrompt.command && installPrompt.label) {
      setInstallTarget({ command: installPrompt.command, label: installPrompt.label });
    }
    setInstallPrompt(null);
  }, [installPrompt]);

  const installDialogs = (
    <>
      <AlertDialog open={!!installPrompt} onOpenChange={(open) => { if (!open) setInstallPrompt(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{installPrompt?.title}</AlertDialogTitle>
            <AlertDialogDescription>{installPrompt?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {installPrompt?.action && (
              <AlertDialogCancel onClick={() => setInstallPrompt(null)}>
                {tc('cancel')}
              </AlertDialogCancel>
            )}
            <AlertDialogAction onClick={handlePromptConfirm}>
              {installPrompt?.confirmLabel ?? tc('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {installTarget && (
        <InstallDialog
          open
          onOpenChange={() => setInstallTarget(null)}
          command={installTarget.command}
          label={installTarget.label}
          reloadOnClose={false}
        />
      )}
      <CodexInstallGuideDialog open={codexGuideOpen} onOpenChange={setCodexGuideOpen} />
    </>
  );

  return { ensureAgentInstalled, installDialogs };
};
