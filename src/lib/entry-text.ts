import type { ITimelineEntry } from '@/types/timeline';

/**
 * The entry types a transcript search reads. `thinking` and `reasoning-summary`
 * are deliberately out: a search over a private chain of thought surfaces text
 * the user never wrote and never read.
 *
 * The on-device index (mobile story 14, `textForSearch`) mirrors this table
 * field for field so a local hit and a server hit mean the same thing. The one
 * asymmetry is `IToolRecordText`: only the server holds the source record, so
 * only the server can search a tool input or a tool output past the summary the
 * parsers keep.
 */
export const SEARCHABLE_ENTRY_TYPES = [
  'user-message',
  'assistant-message',
  'tool-call',
  'tool-result',
] as const;

export type TSearchableEntryType = (typeof SEARCHABLE_ENTRY_TYPES)[number];

export type TSearchableEntry = Extract<ITimelineEntry, { type: TSearchableEntryType }>;

export interface IToolRecordText {
  /** Tool input as the source record carries it, JSON-stringified. */
  input?: string;
  /** Tool output text as the source record carries it, before summarization. */
  output?: string;
}

export type TToolTextLookup = (toolUseId: string) => IToolRecordText | undefined;

const SEARCHABLE = new Set<string>(SEARCHABLE_ENTRY_TYPES);

export const isSearchableEntry = (entry: ITimelineEntry): entry is TSearchableEntry =>
  SEARCHABLE.has(entry.type);

const joinParts = (parts: (string | undefined)[]): string =>
  parts.filter((part): part is string => Boolean(part && part.trim())).join('\n');

/** The text one entry contributes to a search index. Empty when it contributes none. */
export const entrySearchText = (entry: ITimelineEntry, toolText?: TToolTextLookup): string => {
  if (entry.type === 'user-message') return entry.text;
  if (entry.type === 'assistant-message') return entry.markdown;

  if (entry.type === 'tool-call') {
    return joinParts([
      entry.toolName,
      entry.summary,
      entry.filePath,
      entry.diff?.oldString,
      entry.diff?.newString,
      toolText?.(entry.toolUseId)?.input,
    ]);
  }

  if (entry.type === 'tool-result') {
    return joinParts([entry.summary, toolText?.(entry.toolUseId)?.output]);
  }

  return '';
};
