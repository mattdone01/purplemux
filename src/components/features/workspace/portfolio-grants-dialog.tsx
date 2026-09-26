import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PortfolioGrantsPanel from '@/components/features/workspace/portfolio-grants-panel';
import useGrants from '@/hooks/use-grants';
import useNowTick from '@/hooks/use-now-tick';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { createGrantRequest, revokeGrantRequest } from '@/lib/grants-client';
import { describeGrantFailure, GRANT_DEFAULT_EXPIRY_HOURS, runGrantAction } from '@/lib/grant-view';

interface IPortfolioGrantsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Portfolio grants (story 28; ADR-0014): pick a verified grantee tab, the
 * workspaces it may drive, an expiry, a reason and the purplemux password;
 * list the active grants with Revoke. A refusal shows the served reason. The
 * sidebar mounts this only while open, so each open starts from a clean form.
 */
const PortfolioGrantsDialog = ({ open, onOpenChange }: IPortfolioGrantsDialogProps) => {
  const t = useTranslations('grants');
  const { view, failure, refresh } = useGrants('fresh');
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const now = useNowTick(30_000);
  const [granteeKey, setGranteeKey] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [hours, setHours] = useState<number>(GRANT_DEFAULT_EXPIRY_HOURS);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revokingIds, setRevokingIds] = useState<string[]>([]);

  const describe = (r: { status: number; code: string | null; reason: string | null }): string =>
    describeGrantFailure(r, (key, values) => t(key, values));

  const submit = async () => {
    if (!granteeKey) return;
    const slash = granteeKey.indexOf('/');
    setSubmitting(true);
    setError(null);
    const result = await runGrantAction({
      call: () => createGrantRequest({
        granteeWorkspaceId: granteeKey.slice(0, slash),
        granteeTabId: granteeKey.slice(slash + 1),
        workspaces: targets,
        reason: reason.trim(),
        expiresInHours: hours,
        password,
      }),
      refresh,
      describe,
    });
    setSubmitting(false);
    setPassword('');
    setError(result.error);
    if (result.ok) {
      setTargets([]);
      setReason('');
    }
  };

  const revoke = async (id: string) => {
    setRevokingIds((ids) => [...ids, id]);
    setError(null);
    const result = await runGrantAction({ call: () => revokeGrantRequest(id), refresh, describe });
    setRevokingIds((ids) => ids.filter((x) => x !== id));
    setError(result.error);
  };

  // A failed refresh keeps the last good view (useGrants) and says so; with no view at all, the lists are unknown.
  const readError = failure ? `${view ? t('staleSuffix', { reason: describe(failure) }) : `${t('loadFailed')} — ${describe(failure)}`}` : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <PortfolioGrantsPanel
          available={view !== null}
          grantees={view?.grantees ?? []}
          granteesError={view?.granteesError ?? null}
          unreadableWorkspaceIds={view?.unreadableWorkspaceIds ?? []}
          grants={view?.grants ?? []}
          workspaceNames={Object.fromEntries(workspaces.map((w) => [w.id, w.name]))}
          now={now + (view?.skewMs ?? 0)}
          granteeKey={granteeKey}
          onGranteeChange={(key) => { setGranteeKey(key); setTargets([]); }}
          workspaces={targets}
          onWorkspacesChange={setTargets}
          expiresInHours={hours}
          onExpiryChange={setHours}
          reason={reason}
          onReasonChange={setReason}
          password={password}
          onPasswordChange={setPassword}
          error={error ?? readError}
          submitting={submitting}
          revokingIds={revokingIds}
          onSubmit={submit}
          onRevoke={revoke}
        />
      </DialogContent>
    </Dialog>
  );
};

export default PortfolioGrantsDialog;
