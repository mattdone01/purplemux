/**
 * Whether older entries can actually be fetched for a timeline.
 *
 * `/api/timeline/entries` pages by byte offset into a JSONL transcript, so a
 * source without one — grok, whose transcript lives in SQLite — has nothing to
 * page. Arming the load-older affordance for it leaves a control that can never
 * do anything, so both the init payload and the client guard ask this.
 */
export const canLoadOlder = (
  jsonlPath: string | null | undefined,
  startByteOffset: number,
): jsonlPath is string => Boolean(jsonlPath) && startByteOffset > 0;
