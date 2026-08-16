import { describe, expect, it } from 'vitest';
import { entrySearchText, isSearchableEntry, SEARCHABLE_ENTRY_TYPES } from '@/lib/entry-text';
import type { ITimelineEntry } from '@/types/timeline';

const userMessage: ITimelineEntry = {
  type: 'user-message',
  id: 'u1',
  seq: 0,
  timestamp: 1,
  text: 'ship the settlement batch',
};

const assistantMessage: ITimelineEntry = {
  type: 'assistant-message',
  id: 'a1',
  seq: 1,
  timestamp: 2,
  markdown: 'I will read **the file** first',
};

const toolCall: ITimelineEntry = {
  type: 'tool-call',
  id: 't1',
  seq: 2,
  timestamp: 3,
  toolUseId: 'call-1',
  toolName: 'Read',
  summary: 'Read /tmp/a.ts',
  filePath: '/tmp/a.ts',
  status: 'success',
};

const toolResult: ITimelineEntry = {
  type: 'tool-result',
  id: 'r1',
  seq: 3,
  timestamp: 4,
  toolUseId: 'call-1',
  isError: false,
  summary: '412 lines',
};

const thinking: ITimelineEntry = {
  type: 'thinking',
  id: 'th1',
  seq: 4,
  timestamp: 5,
  thinking: 'the settlement batch needs a rollup',
};

describe('entry-text', () => {
  it('names the four searchable entry types', () => {
    expect([...SEARCHABLE_ENTRY_TYPES]).toEqual([
      'user-message',
      'assistant-message',
      'tool-call',
      'tool-result',
    ]);
  });

  it('takes the message body of a user and an assistant entry', () => {
    expect(entrySearchText(userMessage)).toBe('ship the settlement batch');
    expect(entrySearchText(assistantMessage)).toBe('I will read **the file** first');
  });

  it('excludes thinking from the searchable corpus', () => {
    expect(isSearchableEntry(thinking)).toBe(false);
    expect(entrySearchText(thinking)).toBe('');
  });

  it('carries the tool name, the summary and the raw input of a tool call', () => {
    const text = entrySearchText(toolCall, () => ({ input: '{"file_path":"/tmp/a.ts","limit":40}' }));

    expect(text).toContain('Read');
    expect(text).toContain('Read /tmp/a.ts');
    expect(text).toContain('"limit":40');
  });

  it('carries the raw output of a tool result, which the summary truncates away', () => {
    const text = entrySearchText(toolResult, () => ({ output: 'line 1\nSHIBBOLETH\nline 3' }));

    expect(text).toContain('412 lines');
    expect(text).toContain('SHIBBOLETH');
  });

  it('falls back to the entry alone when no raw record text is available', () => {
    expect(entrySearchText(toolResult)).toBe('412 lines');
    expect(entrySearchText(toolCall)).toBe('Read\nRead /tmp/a.ts\n/tmp/a.ts');
  });
});
