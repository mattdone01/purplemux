import { useState, useMemo, memo } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronRight, Check, LoaderCircle, CircleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import ToolCallItem from '@/components/features/timeline/tool-call-item';
import type { ITimelineToolCall, ITimelineToolResult } from '@/types/timeline';

interface IToolGroupItemProps {
  toolCalls: ITimelineToolCall[];
  toolResults: ITimelineToolResult[];
}

const getGroupDescriptionTags = (toolCalls: ITimelineToolCall[]): string[] => {
  const toolNames = new Set(toolCalls.map((tc) => tc.toolName));
  const tags: string[] = [];
  if (toolNames.has('Read') || toolNames.has('Grep') || toolNames.has('Glob')) {
    tags.push('codeSearched');
  }
  if (toolNames.has('Edit') || toolNames.has('Write')) {
    tags.push('codeEdited');
  }
  return tags;
};

const ToolGroupItem = ({ toolCalls, toolResults }: IToolGroupItemProps) => {
  const t = useTranslations('timeline');
  const tc = useTranslations('common');
  const [isExpanded, setIsExpanded] = useState(false);

  const resultMap = useMemo(() => new Map(toolResults.map((r) => [r.toolUseId, r])), [toolResults]);
  const statusFor = (call: ITimelineToolCall) => {
    const result = resultMap.get(call.toolUseId);
    return result ? (result.isError ? 'error' : 'success') : call.status;
  };
  const hasPending = toolCalls.some((call) => statusFor(call) === 'pending');
  const hasError = toolCalls.some((call) => statusFor(call) === 'error');
  const activeCall = toolCalls.find((call) => statusFor(call) === 'pending')
    ?? toolCalls.find((call) => statusFor(call) === 'error')
    ?? toolCalls.at(-1);
  const preview = activeCall?.summary || activeCall?.toolName;

  const headerText = (() => {
    if (hasPending) return t('commandsRunning', { count: toolCalls.length });
    const tags = getGroupDescriptionTags(toolCalls);
    const translatedTags = tags.map((tag) => t(tag));
    const suffix = translatedTags.length > 0 ? `, ${translatedTags.join(', ')}` : '';
    return `${t('commandsExecuted', { count: toolCalls.length })}${suffix}`;
  })();

  return (
    <div className="animate-in fade-in duration-150">
      <button
        type="button"
        aria-expanded={isExpanded}
        className="flex w-full items-start gap-1.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setIsExpanded((prev) => !prev)}
      >
        <ChevronRight
          size={14}
          className={cn(
            'mt-0.5 shrink-0 transition-transform duration-150',
            isExpanded && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {hasError ? <CircleAlert size={12} className="text-negative" role="img" aria-hidden={false} aria-label={tc('error')} />
              : hasPending ? <LoaderCircle size={12} className="animate-spin motion-reduce:animate-none" />
                : <Check size={12} />}
            <span>{headerText}</span>
          </span>
          {preview && <span className="mt-1 block line-clamp-2 break-all font-mono text-foreground/80">{preview}</span>}
        </span>
      </button>
      {isExpanded && (
        <div className="ml-[7px] mt-0.5 border-l border-border/40 pl-3">
          {toolCalls.map((call) => (
            <ToolCallItem
              key={call.id}
              entry={{ ...call, status: statusFor(call) }}
              result={resultMap.get(call.toolUseId)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default memo(ToolGroupItem);
