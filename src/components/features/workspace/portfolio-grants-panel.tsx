import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import Spinner from '@/components/ui/spinner';
import { GRANT_EXPIRY_HOURS, isGrantActive } from '@/lib/grant-view';
import type { IGrant, IGrantee } from '@/types/grant';

// The grant dialog's content, props only (story 28): every state is rendered
// from what the container passes, so each is pinned by a static-render test.

export interface IPortfolioGrantsPanelProps {
  /** False while loading or after a failed read: the lists are unknown, never shown as empty. */
  available: boolean;
  grantees: IGrantee[];
  grants: IGrant[];
  /** Workspace names by id, for the lists. */
  workspaceNames: Record<string, string>;
  now: number;
  granteeKey: string | null;
  onGranteeChange: (key: string) => void;
  workspaces: string[];
  onWorkspacesChange: (ids: string[]) => void;
  expiresInHours: number;
  onExpiryChange: (hours: number) => void;
  reason: string;
  onReasonChange: (reason: string) => void;
  password: string;
  onPasswordChange: (password: string) => void;
  /** The served refusal, already labelled; never a raw code. */
  error: string | null;
  submitting: boolean;
  revokingId: string | null;
  onSubmit: () => void;
  onRevoke: (id: string) => void;
}

export const granteeKeyOf = (g: { workspaceId: string; tabId: string }): string => `${g.workspaceId}/${g.tabId}`;

const PortfolioGrantsPanel = (props: IPortfolioGrantsPanelProps) => {
  const t = useTranslations('grants');
  const { grantees, grants, workspaceNames, now } = props;
  const grantee = grantees.find((g) => granteeKeyOf(g) === props.granteeKey) ?? null;
  const targets = Object.keys(workspaceNames).filter((id) => id !== grantee?.workspaceId);
  const active = grants.filter((g) => isGrantActive(g, now));
  const nameOf = (id: string) => workspaceNames[id] ?? id;
  const timeOf = (ms: number) => new Date(ms).toLocaleString();
  const canSubmit = !!grantee && grantee.identity === 'launch' && props.workspaces.length > 0
    && props.reason.trim().length > 0 && props.password.length > 0 && !props.submitting;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">{t('intro')}</p>

      <div className="flex flex-col gap-1.5">
        <Label>{t('granteeLabel')}</Label>
        {!props.available ? (
          <p className="text-xs text-muted-foreground" data-unavailable="grantees">—</p>
        ) : grantees.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noGrantees')}</p>
        ) : (
          <RadioGroup value={props.granteeKey ?? ''} onValueChange={(v) => props.onGranteeChange(String(v))} className="max-h-40 gap-1 overflow-y-auto">
            {grantees.map((g) => {
              const key = granteeKeyOf(g);
              const disabled = g.identity !== 'launch';
              return (
                <label key={key} className="flex items-center gap-2 text-xs" data-grantee={key} data-disabled={disabled ? 'true' : undefined}>
                  <RadioGroupItem value={key} disabled={disabled} />
                  <span className={disabled ? 'text-muted-foreground' : undefined}>
                    {g.name || g.tabId} <span className="text-muted-foreground">· {g.workspaceName}</span>
                  </span>
                  {disabled && <span className="text-[11px] text-muted-foreground">— {t('granteeUnverified')}</span>}
                </label>
              );
            })}
          </RadioGroup>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>{t('workspacesLabel')}</Label>
        {targets.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noOtherWorkspaces')}</p>
        ) : targets.map((id) => (
          <label key={id} className="flex items-center gap-2 text-xs" data-target={id}>
            <Checkbox
              checked={props.workspaces.includes(id)}
              onCheckedChange={(checked) => props.onWorkspacesChange(
                checked ? [...props.workspaces, id] : props.workspaces.filter((w) => w !== id),
              )}
            />
            {nameOf(id)}
          </label>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>{t('expiryLabel')}</Label>
          <Select
            value={String(props.expiresInHours)}
            onValueChange={(v) => props.onExpiryChange(Number(v))}
            items={GRANT_EXPIRY_HOURS.map((h) => ({ value: String(h), label: t(`expiry${h}`) }))}
          >
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              {GRANT_EXPIRY_HOURS.map((h) => <SelectItem key={h} value={String(h)}>{t(`expiry${h}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="grant-password">{t('passwordLabel')}</Label>
          <Input id="grant-password" type="password" autoComplete="current-password" value={props.password} onChange={(e) => props.onPasswordChange(e.target.value)} />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="grant-reason">{t('reasonLabel')}</Label>
        <Input id="grant-reason" value={props.reason} maxLength={200} placeholder={t('reasonPlaceholder')} onChange={(e) => props.onReasonChange(e.target.value)} />
      </div>

      {props.error && <p className="text-xs text-destructive" role="alert">{props.error}</p>}

      <div className="flex justify-end">
        <Button onClick={props.onSubmit} disabled={!canSubmit}>
          {props.submitting && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
          {t('create')}
        </Button>
      </div>

      <div className="flex flex-col gap-1.5 border-t pt-3">
        <Label>{t('activeTitle')}</Label>
        {!props.available ? (
          <p className="text-xs text-muted-foreground" data-unavailable="grants">—</p>
        ) : active.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('noActive')}</p>
        ) : active.map((g) => {
          const who = grantees.find((c) => granteeKeyOf(c) === granteeKeyOf(g.grantee));
          return (
            <div key={g.id} className="flex items-center justify-between gap-2 text-xs" data-grant={g.id}>
              <span className="min-w-0 truncate">
                {who?.name || g.grantee.tabId} · {nameOf(g.grantee.workspaceId)} — {t('drives', { workspaces: g.workspaces.map(nameOf).join(', ') })}{' '}
                <span className="text-muted-foreground">{t('until', { time: timeOf(g.expiresAt) })}</span>
              </span>
              <Button variant="outline" size="sm" onClick={() => props.onRevoke(g.id)} disabled={props.revokingId === g.id}>
                {props.revokingId === g.id && <Spinner className="mr-1.5 h-3 w-3" />}
                {t('revoke')}
              </Button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default PortfolioGrantsPanel;
