/**
 * Whether older entries can actually be fetched for a timeline.
 *
 * `/api/timeline/entries` pages backwards from a cursor into a JSONL transcript
 * — a byte offset for Claude and Codex, an update ordinal for grok. A source
 * with no transcript, or one whose init already starts at the first entry, has
 * nothing to page, and arming the load-older affordance for it leaves a control
 * that can never do anything; both the init payload and the client guard ask
 * this.
 */
export const canLoadOlder = (
  jsonlPath: string | null | undefined,
  startByteOffset: number,
): jsonlPath is string => Boolean(jsonlPath) && startByteOffset > 0;
