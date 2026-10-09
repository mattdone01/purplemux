// Browser-safe burndown helpers: the snapshot validator shared by the CLI route and
// the staleness rule the Mission Control panel renders. No node-only imports.
import type { IBurndownDoneEvent, IBurndownEpic, IBurndownHistoryRow, IBurndownSnapshot } from '@/types/burndown';

/** The Scrum Master publishes every sweep; two hours without one means the loop stopped. */
export const BURNDOWN_STALE_MS = 2 * 60 * 60 * 1000;

export const MAX_BURNDOWN_HISTORY = 2_000;
export const MAX_BURNDOWN_EPICS = 100;
export const MAX_BURNDOWN_DONE_EVENTS = 1_000;
/** Stored snapshot ceiling, measured on the serialized JSON after history is capped. */
export const MAX_BURNDOWN_BYTES = 1024 * 1024;

const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const MAX_NAME = 200;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// done_at is written by hand in each status.yaml: a date, or a time to the minute or second, with a zone.
const DONE_TIME = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

class BurndownShapeError extends Error {}

const show = (value: unknown): string => {
  if (value === undefined) return 'nothing';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

const refuse = (field: string, value: unknown, expected: string): never => {
  throw new BurndownShapeError(`${field}: saw ${show(value)}, expected ${expected}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const record = (value: unknown, field: string): Record<string, unknown> =>
  isRecord(value) ? value : refuse(field, value, 'an object');

const list = (value: unknown, field: string, max: number): unknown[] => {
  if (!Array.isArray(value)) return refuse(field, value, 'an array');
  if (value.length > max) throw new BurndownShapeError(`${field}: saw ${value.length} entries, expected at most ${max}`);
  return value;
};

const count = (value: unknown, field: string): number =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : refuse(field, value, 'a non-negative integer');

const percent = (value: unknown, field: string): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
    ? value : refuse(field, value, 'a number from 0 to 100');

const slug = (value: unknown, field: string): string =>
  typeof value === 'string' && SLUG.test(value) ? value : refuse(field, value, 'a slug of letters, digits, ".", "_" or "-"');

const name = (value: unknown, field: string): string =>
  typeof value === 'string' && value.trim() && value.length <= MAX_NAME
    ? value.trim() : refuse(field, value, `a non-empty string of at most ${MAX_NAME} characters`);

const utcTime = (value: unknown, field: string): string =>
  typeof value === 'string' && UTC_TIME.test(value) && Number.isFinite(Date.parse(value))
    ? value : refuse(field, value, 'an ISO-8601 UTC time such as 2026-10-09T22:36:41Z');

const doneTime = (value: unknown, field: string): string =>
  typeof value === 'string' && DONE_TIME.test(value) && Number.isFinite(Date.parse(value))
    ? value : refuse(field, value, 'an ISO-8601 date, or a date and time with a zone');

const balanced = (field: string, burned: number, remaining: number, total: number): void => {
  if (burned + remaining !== total) {
    throw new BurndownShapeError(`${field}: saw burned ${burned} + remaining ${remaining} = ${burned + remaining}, expected total ${total}`);
  }
};

const withinStories = (field: string, value: number, stories: number): void => {
  if (value > stories) throw new BurndownShapeError(`${field}: saw ${value}, expected at most stories ${stories}`);
};

const parseDoneEvent = (raw: unknown, field: string): IBurndownDoneEvent => {
  const body = record(raw, field);
  return { at: doneTime(body.at, `${field}.at`), points: count(body.points, `${field}.points`) };
};

const parseEpic = (raw: unknown, field: string): IBurndownEpic => {
  const body = record(raw, field);
  const epic: IBurndownEpic = {
    slug: slug(body.slug, `${field}.slug`),
    name: name(body.name, `${field}.name`),
    stories: count(body.stories, `${field}.stories`),
    unpointed: count(body.unpointed, `${field}.unpointed`),
    total: count(body.total, `${field}.total`),
    burned: count(body.burned, `${field}.burned`),
    remaining: count(body.remaining, `${field}.remaining`),
    pct: percent(body.pct, `${field}.pct`),
    in_progress: count(body.in_progress, `${field}.in_progress`),
    blocked: count(body.blocked, `${field}.blocked`),
    done_events: list(body.done_events, `${field}.done_events`, MAX_BURNDOWN_DONE_EVENTS)
      .map((event, index) => parseDoneEvent(event, `${field}.done_events[${index}]`)),
    undated_burned: count(body.undated_burned, `${field}.undated_burned`),
  };
  balanced(field, epic.burned, epic.remaining, epic.total);
  withinStories(`${field}.unpointed`, epic.unpointed, epic.stories);
  withinStories(`${field}.in_progress`, epic.in_progress, epic.stories);
  withinStories(`${field}.blocked`, epic.blocked, epic.stories);
  const dated = epic.done_events.reduce((sum, event) => sum + event.points, 0);
  if (dated + epic.undated_burned !== epic.burned) {
    throw new BurndownShapeError(`${field}: saw done_events ${dated} + undated_burned ${epic.undated_burned} = ${
      dated + epic.undated_burned}, expected burned ${epic.burned}`);
  }
  return epic;
};

const parseHistoryRow = (raw: unknown, field: string): IBurndownHistoryRow => {
  const body = record(raw, field);
  const row: IBurndownHistoryRow = {
    at: utcTime(body.at, `${field}.at`),
    slug: slug(body.slug, `${field}.slug`),
    total: count(body.total, `${field}.total`),
    burned: count(body.burned, `${field}.burned`),
    remaining: count(body.remaining, `${field}.remaining`),
    pct: percent(body.pct, `${field}.pct`),
    stories: count(body.stories, `${field}.stories`),
    unpointed: count(body.unpointed, `${field}.unpointed`),
  };
  balanced(field, row.burned, row.remaining, row.total);
  withinStories(`${field}.unpointed`, row.unpointed, row.stories);
  return row;
};

export type TBurndownParseResult =
  | { ok: true; snapshot: IBurndownSnapshot; droppedHistory: number }
  | { ok: false; error: string };

/**
 * Validate a published burndown strictly: every known field must have its exact type and the
 * generator's own arithmetic must hold, because a chart drawn from a malformed row is a false
 * statement about progress. Unknown fields are dropped, not stored. History keeps the newest
 * MAX_BURNDOWN_HISTORY rows by time.
 */
export const parseBurndownSnapshot = (raw: unknown, now: number): TBurndownParseResult => {
  try {
    if (!isRecord(raw)) return refuse('body', raw, 'a burndown.json object');
    const generatedAt = utcTime(raw.generated_at, 'generated_at');
    if (Date.parse(generatedAt) > now + FUTURE_TOLERANCE_MS) {
      throw new BurndownShapeError(`generated_at: saw ${generatedAt}, which is in the future of the server clock ${new Date(now).toISOString()}`);
    }
    const epics = list(raw.epics, 'epics', MAX_BURNDOWN_EPICS).map((entry, index) => parseEpic(entry, `epics[${index}]`));
    const seen = new Set<string>();
    epics.forEach((epic, index) => {
      if (seen.has(epic.slug)) refuse(`epics[${index}].slug`, epic.slug, 'a slug that is not a duplicate');
      seen.add(epic.slug);
    });
    if (!Array.isArray(raw.history)) return refuse('history', raw.history, 'an array');
    const history = raw.history.map((entry, index) => parseHistoryRow(entry, `history[${index}]`))
      .map((row, index) => ({ row, index, at: Date.parse(row.at) }))
      .sort((a, b) => a.at - b.at || a.index - b.index)
      .map((entry) => entry.row);
    const droppedHistory = Math.max(0, history.length - MAX_BURNDOWN_HISTORY);
    return { ok: true, snapshot: { generated_at: generatedAt, epics, history: history.slice(droppedHistory) }, droppedHistory };
  } catch (error) {
    if (error instanceof BurndownShapeError) return { ok: false, error: error.message };
    throw error;
  }
};

export const isBurndownStale = (generatedAt: string, now: number): boolean =>
  now - Date.parse(generatedAt) > BURNDOWN_STALE_MS;
