import { z } from 'zod';
import type { IMissionAnswerRequest, TMissionProducerEvent } from '@/types/mission-control';
import { MissionControlError } from '@/lib/mission-control-errors';

const id = z.string().trim().min(1).max(128);
const timestamp = z.number().int().safe().nonnegative();
const revision = z.number().int().safe().nonnegative();
const shortText = z.string().trim().min(1).max(500);
const nullableLongText = z.string().trim().max(8000).nullable();
const epic = z.object({
  id,
  title: shortText,
  url: z.string().url().max(2048).refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)).nullable(),
}).strict();
const storyCounts = z.object({
  total: revision,
  done: revision,
  blocked: revision,
}).strict().refine((value) => value.done <= value.total && value.blocked <= value.total, 'invalid story counts');
const option = z.object({
  id,
  label: shortText,
  description: z.string().trim().max(8000).optional(),
}).strict();
const question = z.object({
  kind: z.enum(['question', 'action']),
  title: shortText,
  context: z.string().trim().min(1).max(8000),
  storyIds: z.array(id).max(20),
  options: z.array(option).max(20),
  recommendation: z.string().trim().max(8000).nullable(),
  blockingScope: z.enum(['none', 'story', 'run']),
  canContinue: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.storyIds).size !== value.storyIds.length) {
    context.addIssue({ code: 'custom', message: 'duplicate story IDs' });
  }
  if (new Set(value.options.map((entry) => entry.id)).size !== value.options.length) {
    context.addIssue({ code: 'custom', message: 'duplicate option IDs' });
  }
});
const base = {
  eventId: id,
  schemaVersion: z.literal(1),
  workspaceId: id,
  runId: id,
  expectedRevision: revision,
  producerAt: timestamp,
  bindingGeneration: revision,
};

const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('run.started'), payload: z.object({ objective: shortText, epic: epic.optional().nullable(), tabId: id }).strict() }).strict(),
  z.object({ ...base, type: z.literal('run.resumed'), payload: z.object({ tabId: id, transferPendingAnswers: z.boolean() }).strict() }).strict(),
  z.object({ ...base, type: z.literal('progress.updated'), payload: z.object({
    objective: shortText.optional(),
    epic: epic.optional().nullable(),
    phase: z.string().trim().max(500).optional().nullable(),
    state: z.enum(['running', 'waiting']).optional(),
    nextStep: nullableLongText.optional(),
    storyCounts: storyCounts.optional().nullable(),
    closeoutPending: z.boolean().optional(),
  }).strict().refine((value) => Object.keys(value).length > 0, 'progress update must change at least one field') }).strict(),
  z.object({ ...base, type: z.literal('run.finished'), payload: z.object({ state: z.enum(['completed', 'cancelled']), summary: z.string().trim().min(1).max(8000), closeoutPending: z.boolean() }).strict() }).strict(),
  z.object({ ...base, type: z.literal('attention.opened'), payload: question.extend({ itemId: id }) }).strict(),
  z.object({ ...base, type: z.literal('attention.updated'), payload: question.extend({ itemId: id }) }).strict(),
  z.object({ ...base, type: z.literal('attention.resolved'), payload: z.object({ itemId: id, resolution: z.string().trim().min(1).max(8000) }).strict() }).strict(),
  z.object({ ...base, type: z.literal('attention.cancelled'), payload: z.object({ itemId: id, reason: z.string().trim().min(1).max(8000) }).strict() }).strict(),
  z.object({ ...base, type: z.literal('answer.acknowledged'), payload: z.object({ answerId: id }).strict() }).strict(),
]);

const answerSchema = z.object({
  submissionId: id,
  expectedRevision: revision,
  optionIds: z.array(id).max(20),
  text: z.string().trim().max(8000),
  actionCompleted: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.optionIds).size !== value.optionIds.length) {
    context.addIssue({ code: 'custom', message: 'duplicate option selections' });
  }
  if (!value.optionIds.length && !value.text && !value.actionCompleted) {
    context.addIssue({ code: 'custom', message: 'answer must select an option, provide text, or complete the action' });
  }
});

const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new MissionControlError(400, 'invalid-request', result.error.issues[0]?.message ?? 'invalid request');
  }
  return result.data;
};

export const parseMissionEvents = (input: unknown): TMissionProducerEvent[] => {
  const events = parse(z.array(eventSchema).min(1).max(25), input);
  const eventIds = events.map((event) => event.eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    throw new MissionControlError(400, 'invalid-request', 'duplicate event IDs in batch');
  }
  return events as TMissionProducerEvent[];
};

export const parseMissionAnswer = (input: unknown): IMissionAnswerRequest =>
  parse(answerSchema, input);

export const parseMissionCursor = (value: unknown, fallback: number): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new MissionControlError(400, 'invalid-request', 'cursor must be a nonnegative integer');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new MissionControlError(400, 'invalid-request', 'cursor must be a safe integer');
  }
  return parsed;
};

export const parseMissionLimit = (value: unknown, fallback: number, maximum: number): number => {
  const parsed = parseMissionCursor(value, fallback);
  if (parsed < 1 || parsed > maximum) {
    throw new MissionControlError(400, 'invalid-request', `limit must be between 1 and ${maximum}`);
  }
  return parsed;
};
