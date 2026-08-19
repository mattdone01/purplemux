import { useState, useEffect, useCallback, useRef, memo } from 'react';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { MessageCircleQuestion, Check, TerminalSquare, AlertTriangle, Send } from 'lucide-react';
import Spinner from '@/components/ui/spinner';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { IAskQuestionPaneState } from '@/lib/ask-user-question-pane';
import {
  answerAndSubmit,
  createPaneWatcher,
  formHasMultiSelect,
  isSingleShotPrompt,
  isWebAnswerable,
  submitAnswers,
} from '@/lib/ask-user-question-flow';
import type { IAttempt, TAttemptStatus } from '@/lib/ask-user-question-flow';
import type { IAskUserQuestionItem, ITimelineAskUserQuestion } from '@/types/timeline';

interface IAskUserQuestionItemProps {
  entry: ITimelineAskUserQuestion;
  sessionName?: string;
}

const sendInput = async (session: string, input: string): Promise<boolean> => {
  try {
    const res = await fetch('/api/tmux/send-input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, input }),
    });
    return res.ok;
  } catch {
    return false;
  }
};

const sendSelection = (session: string, optionIndex: number): Promise<boolean> =>
  sendInput(session, String(optionIndex + 1));

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const UNREADABLE: IAskQuestionPaneState = {
  phase: 'unavailable',
  activeIndex: -1,
  answered: [],
  complete: false,
  options: [],
  answers: [],
};

const fetchPaneState = async (
  session: string,
  questions: IAskUserQuestionItem[],
): Promise<IAskQuestionPaneState> => {
  try {
    const res = await fetch('/api/tmux/ask-question-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session,
        questions: questions.map((q) => ({ question: q.question, header: q.header, multiSelect: q.multiSelect })),
      }),
    });
    if (!res.ok) return UNREADABLE;
    const data = await res.json();
    const phase = data.phase as IAskQuestionPaneState['phase'];
    if (phase !== 'question' && phase !== 'submit' && phase !== 'absent') return UNREADABLE;
    return {
      phase,
      activeIndex: typeof data.activeIndex === 'number' ? data.activeIndex : -1,
      answered: Array.isArray(data.answered) ? data.answered : [],
      complete: Boolean(data.complete),
      options: Array.isArray(data.options) ? data.options : [],
      answers: Array.isArray(data.answers) ? data.answers : [],
    };
  } catch {
    return UNREADABLE;
  }
};

interface IQuestionBlockProps {
  question: IAskUserQuestionItem;
  isAnswered: boolean;
  /** The chosen option, whether it came from the tool result or the pane's Submit-tab echo. */
  answerLabel?: string | null;
  /** Optimistic index used only by the single-question path, before any result arrives. */
  localSelected?: number | null;
  selectable: boolean;
  pending: boolean;
  note?: string;
  onSelect: (idx: number, label: string) => void;
}

const QuestionBlock = ({
  question,
  isAnswered,
  answerLabel,
  localSelected = null,
  selectable,
  pending,
  note,
  onSelect,
}: IQuestionBlockProps) => (
  <div>
    <div className="mb-2.5 flex items-center gap-2 text-xs font-medium text-claude-active">
      <MessageCircleQuestion size={14} />
      <span>{question.header}</span>
    </div>

    <p className="mb-3 text-sm">{question.question}</p>

    {note && (
      <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <TerminalSquare size={12} />
        {note}
      </p>
    )}

    <div className="flex flex-col gap-1.5">
      {question.options.map((option, idx) => {
        const isSelected = isAnswered || answerLabel
          ? answerLabel === option.label
          : localSelected === idx;
        const isLocalPending = pending && localSelected === idx && !isAnswered;
        const dimmed = (isAnswered || !!answerLabel || localSelected !== null) && !isSelected;

        return (
          <button
            key={idx}
            type="button"
            disabled={!selectable}
            onClick={() => onSelect(idx, option.label)}
            className={cn(
              'flex items-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm transition-colors',
              isSelected
                ? 'border-claude-active/40 bg-claude-active/10'
                : dimmed
                  ? 'border-border/30 opacity-50'
                  : 'border-border/50',
              selectable && 'cursor-pointer hover:border-claude-active/30 hover:bg-claude-active/5',
            )}
          >
            <span
              className={cn(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-xs font-medium',
                isSelected
                  ? 'bg-claude-active text-white'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {isLocalPending ? (
                <Spinner size={10} />
              ) : isSelected ? (
                <Check size={12} />
              ) : (
                idx + 1
              )}
            </span>
            <div className="min-w-0 flex-1">
              <span className="font-medium">{option.label}</span>
              {option.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{option.description}</p>
              )}
            </div>
          </button>
        );
      })}
    </div>
  </div>
);

const PromptShell = ({ children }: { children: ReactNode }) => (
  <div className="animate-in fade-in duration-150">
    <div className="rounded-lg border border-claude-active/20 bg-claude-active/5 px-4 py-3">
      {children}
    </div>
  </div>
);

const SingleQuestionPrompt = ({ entry, sessionName }: IAskUserQuestionItemProps) => {
  const t = useTranslations('timeline');
  const [localSelected, setLocalSelected] = useState<number | null>(null);
  const isAnswered = entry.status === 'success';
  const question = entry.questions[0];

  const isSelectable = !isAnswered && localSelected === null && !!sessionName;

  const handleSelect = async (idx: number) => {
    if (!isSelectable) return;

    setLocalSelected(idx);
    const ok = await sendSelection(sessionName, idx);
    if (!ok) {
      setLocalSelected(null);
      toast.error(t('selectionFailed'));
    }
  };

  return (
    <PromptShell>
      <QuestionBlock
        question={question}
        isAnswered={isAnswered}
        answerLabel={entry.answer}
        localSelected={localSelected}
        selectable={isSelectable}
        pending
        onSelect={handleSelect}
      />
    </PromptShell>
  );
};

// Every non-terminal outcome the flow can report, mapped to something the
// operator can act on. A silent stall is the bug this component exists to kill.
const ATTEMPT_MESSAGE: Record<TAttemptStatus, string | null> = {
  answered: null,
  submitted: null,
  'multi-select': 'askMultiSelectTerminal',
  moved: 'askTerminalMoved',
  incomplete: 'askSubmitIncomplete',
  'no-match': 'askOptionMissing',
  'send-failed': 'selectionFailed',
  stalled: 'askAdvanceStalled',
  unavailable: 'askStateUnavailable',
};

const MultiQuestionPrompt = ({ entry, sessionName }: IAskUserQuestionItemProps) => {
  const t = useTranslations('timeline');
  const questions = entry.questions;
  const isAnswered = entry.status === 'success';
  const [pane, setPane] = useState<IAskQuestionPaneState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<TAttemptStatus | null>(null);

  const readPane = useCallback(
    () => (sessionName ? fetchPaneState(sessionName, questions) : Promise.resolve(UNREADABLE)),
    [sessionName, questions],
  );

  const sendDigit = useCallback(
    (digit: string) => (sessionName ? sendInput(sessionName, digit) : Promise.resolve(false)),
    [sessionName],
  );

  const refresh = useCallback(async () => {
    const next = await readPane();
    setPane(next);
    setNotice(next.phase === 'unavailable' ? 'unavailable' : null);
  }, [readPane]);

  // The watcher pauses while an answer is in flight (that flow drives its own
  // polls); the ref keeps `busy` visible to it without restarting the loop.
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Poll, don't read once: the timeline entry lands in the jsonl the moment
  // the tool is called and the TUI paints the form a beat later, so a single
  // mount-time read can win that race, report `absent`, and leave the card
  // permanently dead ("answered in the terminal") with nothing clickable.
  // Polling also keeps the card honest when the operator answers some
  // questions in the terminal tab while this card is open.
  useEffect(() => {
    if (!sessionName || isAnswered) return;
    const watcher = createPaneWatcher({
      read: readPane,
      isPaused: () => busyRef.current,
      onState: (next) => {
        setPane(next);
        // A poll tick only manages the readability notice — an action's own
        // outcome (no-match, stalled, …) stays until the next action or a
        // manual recheck clears it.
        setNotice((current) => {
          if (next.phase === 'unavailable') return current ?? 'unavailable';
          return current === 'unavailable' ? null : current;
        });
      },
    });
    watcher.start();
    return () => watcher.stop();
  }, [sessionName, isAnswered, readPane]);

  const activeIndex = pane?.phase === 'question' ? pane.activeIndex : -1;
  const onSubmitTab = !isAnswered && pane?.phase === 'submit';
  const promptGone = isAnswered || pane?.phase === 'absent';
  const answeredTabs = pane?.answered ?? [];

  const apply = (steps: IAttempt[]) => {
    const last = steps[steps.length - 1];
    const state = [...steps].reverse().find((step) => step.state)?.state;
    if (state) setPane(state);

    const message = ATTEMPT_MESSAGE[last.status];
    setNotice(message ? last.status : null);
    if (message) toast.error(t(message));
  };

  const handleSelect = async (qIndex: number, optionLabel: string) => {
    if (busy || qIndex !== activeIndex) return;

    setBusy(true);
    apply(
      await answerAndSubmit({
        questions,
        questionIndex: qIndex,
        optionLabel,
        read: readPane,
        sendDigit,
        sleep,
      }),
    );
    setBusy(false);
  };

  const handleSubmit = async () => {
    if (busy) return;
    setBusy(true);
    apply([await submitAnswers({ read: readPane, sendDigit, sleep })]);
    setBusy(false);
  };

  const noteFor = (question: IAskUserQuestionItem, index: number): string | undefined => {
    if (promptGone) return undefined;
    if (!isWebAnswerable(question)) return t('askMultiSelectTerminal');
    if (index === activeIndex) return undefined;
    if (answeredTabs[index]) return t('askAnsweredInTerminal');
    if (activeIndex >= 0) return t('askAwaitingQuestion');
    return undefined;
  };

  const hasMultiSelect = formHasMultiSelect(questions);

  const submitLabel = (): string => {
    if (promptGone) return t('askSubmitDone');
    if (onSubmitTab && pane?.complete) return t('askReviewReady');
    return t('askSubmitPending');
  };

  return (
    <PromptShell>
      <div className="flex flex-col gap-4">
        {questions.map((question, index) => (
          <QuestionBlock
            key={index}
            question={question}
            isAnswered={isAnswered}
            answerLabel={pane?.answers[index] ?? (questions.length === 1 ? entry.answer : undefined)}
            selectable={!promptGone && !busy && index === activeIndex && isWebAnswerable(question)}
            pending={busy && index === activeIndex}
            note={noteFor(question, index)}
            onSelect={(_idx, optionLabel) => handleSelect(index, optionLabel)}
          />
        ))}
      </div>

      {/* The TUI parks on Submit and waits forever, so the step is always shown. */}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Send size={12} />
          {submitLabel()}
        </span>
        {onSubmitTab && (
          <button
            type="button"
            disabled={busy || !pane?.complete}
            onClick={handleSubmit}
            className="flex items-center gap-1.5 rounded-md border border-claude-active/40 bg-claude-active/10 px-3 py-1.5 text-xs font-medium transition-colors hover:bg-claude-active/20 disabled:opacity-50"
          >
            {busy ? <Spinner size={10} /> : <Check size={12} />}
            {t('askSubmitAnswers')}
          </button>
        )}
      </div>

      {hasMultiSelect && !promptGone && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <TerminalSquare size={12} />
          {t('askMultiSelectSubmitCaveat')}
        </p>
      )}

      {notice && !promptGone && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <AlertTriangle size={12} className="text-claude-active" />
          <span>{t(ATTEMPT_MESSAGE[notice] ?? 'askStateUnavailable')}</span>
          <button
            type="button"
            disabled={busy}
            onClick={refresh}
            className="rounded-md border border-border/50 px-2 py-1 font-medium transition-colors hover:border-claude-active/30 disabled:opacity-50"
          >
            {t('askRecheck')}
          </button>
        </div>
      )}
    </PromptShell>
  );
};

const AskUserQuestionItem = ({ entry, sessionName }: IAskUserQuestionItemProps) => {
  if (entry.questions.length === 0) return null;

  return isSingleShotPrompt(entry.questions)
    ? <SingleQuestionPrompt entry={entry} sessionName={sessionName} />
    : <MultiQuestionPrompt entry={entry} sessionName={sessionName} />;
};

export default memo(AskUserQuestionItem);
