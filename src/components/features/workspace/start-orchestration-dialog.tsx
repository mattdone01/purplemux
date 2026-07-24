import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import Spinner from '@/components/ui/spinner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import { DEFAULT_KICKOFF_TEMPLATE, resolveKickoffTemplate } from '@/lib/orchestration';
import { startOrchestration } from '@/lib/orchestration-client';
import { isValidModelName } from '@/lib/claude-command-shared';

interface IStartOrchestrationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  paneId: string;
}

const StartOrchestrationDialog = ({
  open,
  onOpenChange,
  workspaceId,
  paneId,
}: IStartOrchestrationDialogProps) => {
  const t = useTranslations('orchestration');
  const tc = useTranslations('common');
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  const savedTemplate = workspace?.orchestration?.kickoffTemplate ?? null;

  const [task, setTask] = useState('');
  const [model, setModel] = useState('');
  const [showTemplate, setShowTemplate] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prevOpen, setPrevOpen] = useState(open);
  if (prevOpen !== open) {
    setPrevOpen(open);
    if (open) {
      setTask('');
      setModel('');
      setShowTemplate(false);
      setTemplate(null);
      setIsSubmitting(false);
      setError(null);
    }
  }

  const effectiveTemplate = template ?? savedTemplate ?? DEFAULT_KICKOFF_TEMPLATE;
  const trimmedModel = model.trim();
  const canSubmit = task.trim().length > 0
    && (!trimmedModel || isValidModelName(trimmedModel))
    && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !workspace) return;
    setIsSubmitting(true);
    setError(null);
    const prompt = resolveKickoffTemplate(effectiveTemplate, {
      workspaceId,
      workspaceName: workspace.name,
      task: task.trim(),
    });
    const tab = await startOrchestration(workspaceId, {
      paneId,
      prompt,
      ...(trimmedModel ? { model: trimmedModel } : {}),
      ...(template !== null && template !== savedTemplate ? { template } : {}),
    });
    setIsSubmitting(false);
    if (tab) {
      onOpenChange(false);
    } else {
      setError(t('startFailed'));
    }
  }, [canSubmit, workspace, effectiveTemplate, workspaceId, task, paneId, trimmedModel, template, savedTemplate, onOpenChange, t]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('dialogTitle')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="orchestration-task">{t('taskLabel')}</Label>
            <Textarea
              id="orchestration-task"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={t('taskPlaceholder')}
              rows={5}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="orchestration-model">{t('modelLabel')}</Label>
            <Input
              id="orchestration-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t('modelPlaceholder')}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              onClick={() => setShowTemplate((v) => !v)}
            >
              {showTemplate ? t('hideTemplate') : t('editTemplate')}
            </button>
            {showTemplate && (
              <>
                <Textarea
                  value={effectiveTemplate}
                  onChange={(e) => setTemplate(e.target.value)}
                  rows={12}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">{t('templateHint')}</p>
              </>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {tc('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {isSubmitting && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
            {t('start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default StartOrchestrationDialog;
