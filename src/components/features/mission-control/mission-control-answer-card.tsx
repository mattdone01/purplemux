import { AlertTriangle, Check, CircleHelp, Clock3, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import {
  deliveryStatus,
  formatMissionAge,
  isMissionDraftEmpty,
} from '@/components/features/mission-control/mission-control-utils';
import type { IMissionDraft, IMissionDraftPatch } from '@/components/features/mission-control/mission-control-utils';
import type {
  IMissionAnswer,
  IMissionAttentionItem,
  IMissionDelivery,
} from '@/types/mission-control';

interface IMissionAnswerCardProps {
  draft: IMissionDraft;
  workspaceName: string;
  onChange: (patch: IMissionDraftPatch) => void;
  onAdoptCurrent: () => void;
  onSubmit: () => void;
}

const confidenceLabel = (item: IMissionAttentionItem): string => {
  const labels = {
    confirmed: 'Confirmed',
    provisional: 'Provisional',
    unknown: 'Unknown source',
  } as const;
  return `${labels[item.evidence.confidence]} · ${item.evidence.source}`;
};

const MissionControlAnswerCard = ({
  draft,
  workspaceName,
  onChange,
  onAdoptCurrent,
  onSubmit,
}: IMissionAnswerCardProps) => {
  const { item } = draft;
  const submitting = draft.status === 'submitting';
  const toggleOption = (optionId: string) => {
    const selected = draft.optionIds.includes(optionId);
    onChange({
      optionIds: selected
        ? draft.optionIds.filter((candidate) => candidate !== optionId)
        : [...draft.optionIds, optionId],
    });
  };

  return (
    <Card className="min-w-0 border-foreground/10 shadow-none">
      <CardHeader className="gap-3 px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded bg-muted px-2 py-1 font-medium text-foreground">{workspaceName}</span>
          <span>{item.kind === 'action' ? 'Action' : 'Decision'}</span>
          <span>·</span>
          <span>{formatMissionAge(item.createdAt)}</span>
          <span>·</span>
          <span>{confidenceLabel(item)}</span>
        </div>
        <CardTitle className="break-words text-base leading-6">{item.title}</CardTitle>
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
          {item.context}
        </p>
      </CardHeader>
      <CardContent className="space-y-4 px-4 pb-4 sm:px-5 sm:pb-5">
        {item.storyIds.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {item.storyIds.map((storyId) => (
              <span key={storyId} className="rounded bg-ui-blue/10 px-2 py-1 text-xs text-ui-blue">
                {storyId}
              </span>
            ))}
          </div>
        )}

        {item.recommendation && (
          <div className="rounded-md border border-ui-blue/20 bg-ui-blue/5 px-3 py-2 text-sm">
            <span className="font-medium text-ui-blue">Recommendation: </span>
            <span className="break-words text-foreground/80">{item.recommendation}</span>
          </div>
        )}

        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>{item.canContinue ? 'Other work can continue' : 'Work is waiting for this answer'}</span>
          {item.blockingScope !== 'none' && <span>· Blocks {item.blockingScope}</span>}
        </div>

        {item.options.length > 0 && (
          <div className="grid min-w-0 gap-2 sm:grid-cols-2">
            {item.options.map((option) => {
              const selected = draft.optionIds.includes(option.id);
              return (
                <Button
                  key={option.id}
                  type="button"
                  variant="outline"
                  className={cn(
                    'h-auto min-w-0 justify-start whitespace-normal px-3 py-2 text-left',
                    selected && 'border-ui-blue/50 bg-ui-blue/10 text-foreground',
                  )}
                  aria-pressed={selected}
                  disabled={submitting}
                  onClick={() => toggleOption(option.id)}
                >
                  <span className="flex min-w-0 items-start gap-2">
                    <span className={cn(
                      'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                      selected ? 'border-ui-blue bg-ui-blue text-white' : 'border-foreground/20',
                    )}>
                      {selected && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block break-words font-medium">{option.label}</span>
                      {option.description && (
                        <span className="mt-0.5 block break-words text-xs font-normal text-muted-foreground">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        )}

        {item.kind === 'action' && (
          <Button
            type="button"
            variant="outline"
            className={cn(
              'h-auto w-full justify-start whitespace-normal px-3 py-2 text-left',
              draft.actionCompleted && 'border-ui-teal/50 bg-ui-teal/10 text-foreground',
            )}
            aria-pressed={draft.actionCompleted}
            disabled={submitting}
            onClick={() => onChange({ actionCompleted: !draft.actionCompleted })}
          >
            <Check className="h-4 w-4 shrink-0" />
            I&apos;ve completed this action
          </Button>
        )}

        <Textarea
          value={draft.text}
          maxLength={8000}
          disabled={submitting}
          onChange={(event) => onChange({ text: event.target.value })}
          placeholder={item.options.length > 0 ? 'Add context (optional)' : 'Type your answer'}
          aria-label="Answer text"
          className="min-h-24 resize-y"
        />

        {draft.status === 'error' && (
          <div className="flex items-start gap-2 rounded-md border border-ui-red/25 bg-ui-red/5 px-3 py-2 text-sm text-ui-red">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">
              {draft.error}. Your draft is saved here. You can retry safely.
            </span>
          </div>
        )}

        {draft.status === 'conflict' && draft.currentItem && (
          <div className="space-y-3 rounded-md border border-ui-amber/30 bg-ui-amber/5 p-3">
            <div className="flex items-start gap-2 text-sm text-ui-amber">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                {draft.currentItem.state === 'open'
                  ? 'The question changed before this answer was saved. Your draft remains above.'
                  : `This item is now ${draft.currentItem.state} on the server. Your unsaved draft remains above.`}
              </span>
            </div>
            <div className="rounded bg-background/70 p-3 text-sm">
              <p className="font-medium">Current server question</p>
              <p className="mt-1 break-words">{draft.currentItem.title}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                {draft.currentItem.context}
              </p>
            </div>
            {draft.currentItem.state === 'open' && (
              <Button type="button" variant="outline" size="sm" onClick={onAdoptCurrent}>
                Update draft for current question
              </Button>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground">
            {draft.status === 'error' ? 'Saved locally in this page' : 'Saved only after the server confirms'}
          </span>
          <Button
            type="button"
            disabled={submitting || draft.status === 'conflict' || isMissionDraftEmpty(draft)}
            onClick={onSubmit}
            className="w-full sm:w-auto"
          >
            {submitting ? <Clock3 className="h-4 w-4 animate-pulse" /> : <Send className="h-4 w-4" />}
            {submitting ? 'Saving…' : draft.status === 'error' ? 'Retry answer' : 'Save answer'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

interface IMissionDeliveryCardProps {
  item: IMissionAttentionItem;
  answer: IMissionAnswer | undefined;
  delivery: IMissionDelivery | undefined;
  workspaceName: string;
}

const toneClass = {
  neutral: 'text-muted-foreground bg-muted',
  positive: 'text-ui-teal bg-ui-teal/10',
  warning: 'text-ui-amber bg-ui-amber/10',
  negative: 'text-ui-red bg-ui-red/10',
} as const;

export const MissionControlDeliveryCard = ({
  item,
  answer,
  delivery,
  workspaceName,
}: IMissionDeliveryCardProps) => {
  const status = deliveryStatus(delivery);
  return (
    <Card className="min-w-0 border-foreground/10 shadow-none">
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="rounded bg-muted px-2 py-1 text-xs font-medium">{workspaceName}</span>
          <span className={cn('rounded px-2 py-1 text-xs font-medium', toneClass[status.tone])}>
            {status.label}
          </span>
        </div>
        <div>
          <p className="break-words text-sm font-medium">{item.title}</p>
          {answer && (
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {answer.text || (answer.actionCompleted ? 'Action marked complete' : `${answer.optionIds.length} option selected`)}
            </p>
          )}
        </div>
        {delivery?.lastError && (
          <div className="flex items-start gap-2 text-xs text-ui-red">
            <CircleHelp className="h-3.5 w-3.5 shrink-0" />
            <span className="break-words">{delivery.lastError}</span>
          </div>
        )}
        {delivery?.nextAttemptAt && delivery.state === 'queued' && (
          <p className="text-xs text-muted-foreground">
            Next readiness check {formatMissionAge(delivery.nextAttemptAt)}
          </p>
        )}
      </CardContent>
    </Card>
  );
};

export default MissionControlAnswerCard;
