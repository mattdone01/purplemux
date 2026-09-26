import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PortfolioGrantsPanel from '@/components/features/workspace/portfolio-grants-panel';
import useGrants from '@/hooks/use-grants';
import useNowTick from '@/hooks/use-now-tick';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { createGrantRequest, revokeGrantRequest } from '@/lib/grants-client';
import { describeGrantFailure, GRANT_DEFAULT_EXPIRY_HOURS } from '@/lib/grant-view';

interface IPortfolioGrantsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Portfolio grants (story 28; ADR-0014): pick a verified grantee tab, the
 * workspaces it may drive, an expiry, a reason and the purplemux password;
 * list the active grants with Revoke. A refusal shows the served reason.
 */
const PortfolioGrantsDialog = ({ open, onOpenChange }: IPortfolioGrantsDialogProps) => {
  const t = useTranslations('grants');
  const { view, failure, refresh } = useGrants();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const now = useNowTick(30_000);
  const [prevOpen, setPrevOpen] = useState(open);
  const [granteeKey, setGranteeKey] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [hours, setHours] = useState<number>(GRANT_DEFAULT_EXPIRY_HOURS);
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) {
      setGranteeKey(null);
      setTargets([]);
      setHours(GRANT_DEFAULT_EXPIRY_HOURS);
      setReason('');
      setPassword('');
      setError(null);
    }
  }

  const describe = (r: { status: number; code: string | null; reason: string | null }): string =>
    describeGrantFailure(r, (key, values) => t(key, values));

  const submit = async () => {
    if (!granteeKey) return;
    const slash = granteeKey.indexOf('/');
    setSubmitting(true);
    setError(null);
    const r = await createGrantRequest({
      granteeWorkspaceId: granteeKey.slice(0, slash),
      granteeTabId: granteeKey.slice(slash + 1),
      workspaces: targets,
      reason: reason.trim(),
      expiresInHours: hours,
      password,
    });
    setSubmitting(false);
    setPassword('');
    if (r.ok) {
      setTargets([]);
      setReason('');
      await refresh();
    } else {
      setError(describe(r));
    }
  };

  const revoke = async (id: string) => {
    setRevokingId(id);
    setError(null);
    const r = await revokeGrantRequest(id);
    setRevokingId(null);
    if (r.ok) await refresh();
    else setError(describe(r));
  };

  const loadError = failure ? `${t('loadFailed')} — ${describe(failure)}` : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
        </DialogHeader>
        <PortfolioGrantsPanel
          available={view !== null}
          grantees={view?.grantees ?? []}
          grants={view?.grants ?? []}
          workspaceNames={Object.fromEntries(workspaces.map((w) => [w.id, w.name]))}
          now={now}
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
          error={error ?? loadError}
          submitting={submitting}
          revokingId={revokingId}
          onSubmit={submit}
          onRevoke={revoke}
        />
      </DialogContent>
    </Dialog>
  );
};

export default PortfolioGrantsDialog;
