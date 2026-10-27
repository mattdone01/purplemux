import { cn } from '@/lib/utils';
import {
  ATTENTION_CLASS_KEYS,
  ATTENTION_CLASS_LABELS,
  attentionClassKey,
  isAttentionClass,
} from '@/lib/attention-class';
import type { TAttentionClassKey } from '@/lib/attention-class';
import type { IMissionAnswerClassCount, IMissionAttentionItem } from '@/types/mission-control';

const DAY_MS = 86_400_000;
const STRIP_DAYS = 7;

const classTone: Record<TAttentionClassKey, string> = {
  money: 'bg-ui-amber/10 text-ui-amber',
  irreversible: 'bg-ui-red/10 text-ui-red',
  scope: 'bg-ui-purple/10 text-ui-purple',
  bookkeeping: 'bg-ui-teal/10 text-ui-teal',
  unclassified: 'bg-muted text-muted-foreground',
};

export const AttentionClassBadge = ({ value }: { value: IMissionAttentionItem['class'] }) => {
  const key = attentionClassKey(value);
  const unrecognised = value != null && !isAttentionClass(value);
  return (
    <span
      className={cn('rounded px-2 py-1 font-medium', classTone[key])}
      data-attention-class={key}
      title={unrecognised ? `Served class: ${String(value)}` : undefined}
    >
      {unrecognised ? 'Unrecognised class' : ATTENTION_CLASS_LABELS[key]}
    </span>
  );
};

/** The stated default's option label; null when the item states none. Never the raw option ID. */
export const statedDefaultLabel = (item: IMissionAttentionItem): string | null => {
  if (item.defaultOptionId == null) return null;
  return item.options.find((option) => option.id === item.defaultOptionId)?.label ?? 'an option no longer offered';
};

const stripDays = (generatedAt: number): string[] => {
  const today = Math.floor(generatedAt / DAY_MS) * DAY_MS;
  return Array.from({ length: STRIP_DAYS }, (_, index) =>
    new Date(today - (STRIP_DAYS - 1 - index) * DAY_MS).toISOString().slice(0, 10));
};

export const AnswersByClassStrip = ({
  rows,
  generatedAt,
}: {
  rows: IMissionAnswerClassCount[] | undefined;
  generatedAt: number;
}) => {
  if (!rows) {
    return <p className="text-xs text-muted-foreground">Answers per class are not available from this server.</p>;
  }
  const days = stripDays(generatedAt);
  const cells = new Map<string, { total: number; rule: number }>();
  for (const row of rows) {
    const key = `${row.day}:${attentionClassKey(row.class)}`;
    const cell = cells.get(key) ?? { total: 0, rule: 0 };
    cell.total += row.count;
    if (row.by === 'rule') cell.rule += row.count;
    cells.set(key, cell);
  }
  return (
    <div className="min-w-0 overflow-x-auto">
      <table className="w-full min-w-[28rem] text-xs tabular-nums">
        <caption className="pb-1 text-left text-muted-foreground">Answers per class, last 7 days (UTC)</caption>
        <thead>
          <tr className="text-muted-foreground">
            <th scope="col" className="py-1 pr-2 text-left font-normal">Class</th>
            {days.map((day) => <th key={day} scope="col" className="px-1 py-1 text-right font-normal">{day.slice(5)}</th>)}
          </tr>
        </thead>
        <tbody>
          {ATTENTION_CLASS_KEYS.map((classKey) => (
            <tr key={classKey} className="border-t border-foreground/5">
              <th scope="row" className="py-1 pr-2 text-left font-medium">{ATTENTION_CLASS_LABELS[classKey]}</th>
              {days.map((day) => {
                const cell = cells.get(`${day}:${classKey}`);
                return (
                  <td key={day} className="px-1 py-1 text-right" data-strip-cell={`${day}:${classKey}`}>
                    {cell ? `${cell.total}${cell.rule ? ` (${cell.rule} by rule)` : ''}` : 0}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
