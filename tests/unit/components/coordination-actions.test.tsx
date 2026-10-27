import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Story 06: the owner-note and lease-break forms gate their submit on the bounds they share with
// the server (consult Q2), and every action outcome reaches the human as one sonner toast.

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const load = () => import('@/components/features/mission-control/coordination-actions');

const WORKSPACES = [{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-b', name: 'Beta' }];
const submitButton = (html: string) => html.slice(html.lastIndexOf('<button'), html.lastIndexOf('</button>'));

describe('coordination actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('OwnerNoteForm', () => {
    it('starts with submit disabled and no error line', async () => {
      const { OwnerNoteForm } = await load();
      const html = renderToStaticMarkup(<OwnerNoteForm workspaces={WORKSPACES} submitting={false} onSubmit={vi.fn()} />);
      expect(html).toContain('data-owner-note-form=""');
      expect(html).toContain('Choose a workspace');
      expect(submitButton(html)).toContain('disabled=""');
      expect(html).not.toContain('data-field-error');
      expect(html).toContain('a human is never a note recipient');
      // The served from-word (noteFromWords), never a phrase of the form's own.
      expect(html).toContain('sees it from &quot;human&quot;');
    });

    it('enables submit for a valid note, and disables it while sending', async () => {
      const { OwnerNoteForm } = await load();
      const initial = { to: 'workspace' as const, target: 'ws-b', subject: 'Pause', body: 'Hold merges' };
      expect(submitButton(renderToStaticMarkup(<OwnerNoteForm workspaces={WORKSPACES} submitting={false} onSubmit={vi.fn()} initial={initial} />)))
        .not.toContain('disabled=""');
      expect(submitButton(renderToStaticMarkup(<OwnerNoteForm workspaces={WORKSPACES} submitting onSubmit={vi.fn()} initial={initial} />)))
        .toContain('disabled=""');
    });

    it('names each field to fix in the server\'s units', async () => {
      const { OwnerNoteForm } = await load();
      const html = renderToStaticMarkup(<OwnerNoteForm workspaces={WORKSPACES} submitting={false} onSubmit={vi.fn()}
        initial={{ to: 'epic', target: ' ', subject: '😀'.repeat(121), body: 'é'.repeat(8193) }} />);
      expect(html).toContain('id="owner-note-epic"');
      expect(html).toContain('Choose where the note goes');
      expect(html).toContain('At most 120 characters');
      expect(html).toContain('At most 16 KiB');
      expect(submitButton(html)).toContain('disabled=""');
    });

    it('says when no workspace list is loaded instead of an empty choice', async () => {
      const { OwnerNoteForm } = await load();
      expect(renderToStaticMarkup(<OwnerNoteForm workspaces={[]} submitting={false} onSubmit={vi.fn()} />)).toContain('No workspaces loaded');
    });
  });

  describe('LeaseBreakForm', () => {
    it('requires a reason of 1..500 characters before the destructive submit enables', async () => {
      const { LeaseBreakForm } = await load();
      const render = (initialReason?: string, submitting = false) =>
        renderToStaticMarkup(<LeaseBreakForm lease={{ name: 'merge:x/y' }} submitting={submitting} onSubmit={vi.fn()} initialReason={initialReason} />);
      const blank = render();
      expect(blank).toContain('data-lease-break-form="merge:x/y"');
      expect(submitButton(blank)).toContain('disabled=""');
      expect(blank).not.toContain('data-field-error');
      expect(render('   ')).toContain('A reason is required');
      expect(render('r'.repeat(501))).toContain('At most 500 characters');
      expect(submitButton(render('holder crashed'))).not.toContain('disabled=""');
      expect(submitButton(render('holder crashed', true))).toContain('disabled=""');
    });
  });

  describe('outcome toasts', () => {
    it('a done action toasts success; a refusal or failure toasts its served sentence', async () => {
      const { toastOutcome } = await load();
      expect(toastOutcome({ kind: 'done', body: { n: 1 } }, (b) => `ok ${b.n}`)).toBe(true);
      expect(toast.success).toHaveBeenCalledWith('ok 1');
      expect(toastOutcome({ kind: 'refused', code: 'note-cap', text: 'Too many open notes: limit 50' }, () => 'x')).toBe(false);
      expect(toastOutcome({ kind: 'failed', text: 'Request failed (HTTP 502)' }, () => 'x')).toBe(false);
      expect(toast.error.mock.calls).toEqual([['Too many open notes: limit 50'], ['Request failed (HTTP 502)']]);
    });

    it('a sent note names its routing state through a label, never the token', async () => {
      const { noteSentText } = await load();
      expect(noteSentText({ state: 'queued' })).toBe('Note sent — queued for its orchestrator');
      expect(noteSentText({ state: 'undeliverable' })).toBe('Note sent — stored, but not deliverable now');
      expect(noteSentText({ state: 'brand-new' as 'queued' })).toBe('Note sent — state unknown');
    });
  });
});
