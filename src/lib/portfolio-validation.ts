import { z } from 'zod';
import { MissionControlError } from '@/lib/mission-control-errors';
import type { IPortfolioReport, IPortfolioResolution, IPortfolioSelection } from '@/types/portfolio';

const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(500);
const time = z.number().int().safe().nonnegative();
const capacity = z.object({
  host: text,
  measuredReason: text,
  limit: text.nullable(),
  use: text.nullable(),
  holder: text.nullable(),
  clearingCondition: text.nullable(),
}).strict();

const report = z.object({
  eventId: id,
  schemaVersion: z.literal(1),
  workspaceId: id,
  runId: id,
  bindingGeneration: time,
  sourceKey: id,
  revision: time,
  producerAt: time,
  resourceKey: id,
  kind: z.enum(['ci', 'lease', 'worker-limit', 'build-slots', 'memory', 'disk-reservation', 'other']),
  watchId: id.nullable(),
  watchHead: z.string().regex(/^[a-f0-9]{7,40}$/).nullable(),
  outcome: text,
  priority: z.number().int().min(0).max(100),
  stage: z.enum(['implemented', 'reviewed', 'merged', 'deployed', 'verified']),
  owner: text,
  cause: z.string().trim().min(1).max(2000),
  evidence: z.string().trim().min(1).max(2000),
  nextAction: z.string().trim().min(1).max(2000),
  decisionOwner: text,
  checkpointAt: time.nullable(),
  capacity: capacity.nullable(),
}).strict().superRefine((value, ctx) => {
  if (['worker-limit', 'build-slots', 'memory', 'disk-reservation', 'lease'].includes(value.kind) && !value.capacity) {
    ctx.addIssue({ code: 'custom', message: 'capacity details are required for resource blockers' });
  }
  if (['worker-limit', 'build-slots', 'memory', 'disk-reservation'].includes(value.kind) && value.watchId) {
    ctx.addIssue({ code: 'custom', message: 'supplied capacity blockers use coordinator evidence, not an unrelated watch' });
  }
});

const selection = z.object({
  managerWorkspaceId: id,
  managerTabId: id,
  workspaceIds: z.array(id).max(100),
}).strict().refine((value) => new Set(value.workspaceIds).size === value.workspaceIds.length, 'duplicate workspaces');

const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const result = schema.safeParse(input);
  if (!result.success) throw new MissionControlError(400, 'invalid-request', result.error.issues[0]?.message ?? 'invalid request');
  return result.data;
};

export const parsePortfolioReport = (input: unknown): IPortfolioReport => parse(report, input);
export const parsePortfolioSelection = (input: unknown): IPortfolioSelection => parse(selection, input);
export const parsePortfolioAction = (input: unknown): { actionId: string; workspaceId: string; impactId: string;
  expectedRevision: number; decision: string } =>
  parse(z.object({ actionId: id, workspaceId: id, impactId: id, expectedRevision: time,
    decision: z.string().trim().min(1).max(4000) }).strict(), input);

export const parsePortfolioApplied = (input: unknown): { workspaceId: string; runId: string; bindingGeneration: number;
  impactId: string; noteId: string; eventId: string; expectedRevision: number; schemaVersion: 1 } =>
  parse(z.object({ schemaVersion: z.literal(1), workspaceId: id, runId: id, bindingGeneration: time, impactId: id,
    noteId: id, eventId: id, expectedRevision: time }).strict(), input);

export const parsePortfolioResolution = (input: unknown): IPortfolioResolution =>
  parse(z.object({ schemaVersion: z.literal(1), type: z.literal('resolved'), eventId: id,
    workspaceId: id, runId: id, bindingGeneration: time, impactId: id,
    expectedRevision: time, observedAt: time,
    evidence: z.object({ host: text, measuredReason: text, limit: text.nullable(), use: text.nullable(),
      holder: text.nullable(), clearingCondition: text, reference: text }).strict(),
  }).strict(), input);

export const parsePortfolioMilestone = (input: unknown): { eventId: string; workspaceId: string; runId: string;
  stage: 'merged' | 'deployed' | 'verified'; evidence: string; observedAt: number } =>
  parse(z.object({ eventId: id, workspaceId: id, runId: id,
    stage: z.enum(['merged', 'deployed', 'verified']), evidence: z.string().trim().min(10).max(2000),
    observedAt: time }).strict(), input);
