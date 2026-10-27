import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import Spinner from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import {
  BREAK_REASON_MAX,
  fieldErrors,
  leaseBreakSchema,
  ownerNoteRequest,
  ownerNoteSchema,
  postHumanAction,
  type THumanActionOutcome,
  type TOwnerNoteValues,
} from '@/lib/human-actions';
import type { ILeaseView } from '@/types/lease';
import type { INoteView } from '@/types/note';

// The human coordination actions on the Mission Control coordination panel (ADR-0029 §6-§8):
// a note as owner and a lease break, each in a dialog. The server decides; the forms only gate
// the submit button on the bounds they share with it (consult Q2).

const FieldError = ({ text }: { text?: string }) => (text ? <p className="text-xs text-destructive" data-field-error="">{text}</p> : null);

export interface IOwnerNoteFormProps {
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  submitting: boolean;
  onSubmit: (values: TOwnerNoteValues) => void;
  initial?: Partial<TOwnerNoteValues>;
}

export const OwnerNoteForm = ({ workspaces, submitting, onSubmit, initial = {} }: IOwnerNoteFormProps) => {
  const [values, setValues] = useState<TOwnerNoteValues>({ to: 'workspace', target: '', subject: '', body: '', ...initial });
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set(Object.keys(initial)));
  const parsed = ownerNoteSchema.safeParse(values);
  const errors = parsed.success ? {} : fieldErrors(parsed.error);
  const shown = (field: keyof TOwnerNoteValues) => (touched.has(field) ? errors[field] : undefined);
  const set = (field: keyof TOwnerNoteValues, value: string) => {
    setValues((v) => ({ ...v, [field]: value, ...(field === 'to' ? { target: '' } : {}) }));
    setTouched((t) => new Set(t).add(field));
  };
  return (
    <form
      className="space-y-3"
      data-owner-note-form=""
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.success && !submitting) onSubmit(parsed.data);
      }}
    >
      <div className="flex gap-1" role="group" aria-label="Send to">
        {(['workspace', 'epic'] as const).map((to) => (
          <Button key={to} type="button" size="xs" variant={values.to === to ? 'secondary' : 'ghost'} aria-pressed={values.to === to} onClick={() => set('to', to)}>
            {to === 'workspace' ? 'A workspace' : 'An epic holder'}
          </Button>
        ))}
      </div>
      <div className="space-y-1">
        {values.to === 'workspace' ? (
          <>
            <Label>Workspace</Label>
            <Select items={workspaces.map((w) => ({ label: w.name, value: w.id }))} value={values.target || null} onValueChange={(v) => set('target', String(v ?? ''))}>
              <SelectTrigger className="w-full" data-note-workspace="">
                <SelectValue placeholder={workspaces.length ? 'Choose a workspace' : 'No workspaces loaded'} />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </>
        ) : (
          <>
            <Label htmlFor="owner-note-epic">Epic</Label>
            <Input id="owner-note-epic" placeholder="epic slug, for example purplemux-flow" value={values.target} onChange={(e) => set('target', e.target.value)} />
          </>
        )}
        <FieldError text={shown('target')} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="owner-note-subject">Subject</Label>
        <Input id="owner-note-subject" value={values.subject} onChange={(e) => set('subject', e.target.value)} />
        <FieldError text={shown('subject')} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="owner-note-body">Body</Label>
        <Textarea id="owner-note-body" rows={6} value={values.body} onChange={(e) => set('body', e.target.value)} />
        <FieldError text={shown('body')} />
      </div>
      <p className="text-xs text-muted-foreground">
        The note goes to the target workspace&apos;s orchestrator; its recipient sees it from &quot;human&quot;. Nobody acknowledges it to you: a human is never a note recipient.
      </p>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!parsed.success || submitting}>
          {submitting && <Spinner className="size-3" />}Send note
        </Button>
      </div>
    </form>
  );
};

export interface ILeaseBreakFormProps {
  lease: Pick<ILeaseView, 'name'>;
  submitting: boolean;
  onSubmit: (reason: string) => void;
  initialReason?: string;
}

export const LeaseBreakForm = ({ lease, submitting, onSubmit, initialReason = '' }: ILeaseBreakFormProps) => {
  const [reason, setReason] = useState(initialReason);
  const parsed = leaseBreakSchema.safeParse({ reason });
  const error = !parsed.success && reason.length > 0 ? fieldErrors(parsed.error).reason : undefined;
  return (
    <form
      className="space-y-3"
      data-lease-break-form={lease.name}
      onSubmit={(e) => {
        e.preventDefault();
        if (parsed.success && !submitting) onSubmit(parsed.data.reason);
      }}
    >
      <p className="text-xs text-muted-foreground">
        Breaking <span className="font-mono">{lease.name}</span> releases it at once. The holder is not asked, and the coordination audit records you and the reason.
      </p>
      <div className="space-y-1">
        <Label htmlFor="lease-break-reason">Reason (required, at most {BREAK_REASON_MAX} characters)</Label>
        <Textarea id="lease-break-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
        <FieldError text={error} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" variant="destructive" disabled={!parsed.success || submitting}>
          {submitting && <Spinner className="size-3" />}Break lease
        </Button>
      </div>
    </form>
  );
};

/** One toast per outcome: the served refusal sentence, or the failed request. */
export const toastOutcome = <T,>(outcome: THumanActionOutcome<T>, success: (body: T) => string): boolean => {
  if (outcome.kind === 'done') {
    toast.success(success(outcome.body));
    return true;
  }
  toast.error(outcome.text);
  return false;
};

const NOTE_STATE_LABEL: Record<string, string> = {
  queued: 'queued for its orchestrator', pending: 'waiting for a route', held: 'held by the inbox', delivered: 'delivered',
  undeliverable: 'stored, but not deliverable now', acked: 'acknowledged', expired: 'expired',
};

export const noteSentText = (note: Pick<INoteView, 'state'>): string =>
  `Note sent — ${Object.hasOwn(NOTE_STATE_LABEL, note.state) ? NOTE_STATE_LABEL[note.state] : 'state unknown'}`;

export const OwnerNoteDialog = ({ open, onOpenChange, workspaces, onDone }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaces: ReadonlyArray<{ id: string; name: string }>;
  onDone: () => void;
}) => {
  const [submitting, setSubmitting] = useState(false);
  const submit = async (values: TOwnerNoteValues) => {
    setSubmitting(true);
    const outcome = await postHumanAction<{ note: INoteView }>('/api/mission-control/notes', ownerNoteRequest(values));
    setSubmitting(false);
    if (toastOutcome(outcome, (body) => noteSentText(body.note))) {
      onOpenChange(false);
      onDone();
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send note as owner</DialogTitle>
          <DialogDescription>A note from your session to a workspace&apos;s orchestrator.</DialogDescription>
        </DialogHeader>
        {open && <OwnerNoteForm workspaces={workspaces} submitting={submitting} onSubmit={(v) => { void submit(v); }} />}
      </DialogContent>
    </Dialog>
  );
};

export const LeaseBreakDialog = ({ lease, onClose, onDone }: { lease: ILeaseView | null; onClose: () => void; onDone: () => void }) => {
  const [submitting, setSubmitting] = useState(false);
  const submit = async (name: string, reason: string) => {
    setSubmitting(true);
    const outcome = await postHumanAction<{ broken: ILeaseView }>('/api/mission-control/leases/break', { name, reason });
    setSubmitting(false);
    if (toastOutcome(outcome, (body) => `Lease ${body.broken.name} broken`)) {
      onClose();
      onDone();
    }
  };
  return (
    <Dialog open={lease !== null} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Break lease</DialogTitle>
        </DialogHeader>
        {lease && <LeaseBreakForm key={lease.name} lease={lease} submitting={submitting} onSubmit={(r) => { void submit(lease.name, r); }} />}
      </DialogContent>
    </Dialog>
  );
};
