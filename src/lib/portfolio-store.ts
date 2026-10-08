import { createHash } from 'crypto';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { getMissionControlStore } from '@/lib/mission-control-store';
import { MissionControlError } from '@/lib/mission-control-errors';
import type { IPortfolioAction, IPortfolioImpact, IPortfolioMilestone, IPortfolioReport, IPortfolioResolution, IPortfolioSelection } from '@/types/portfolio';
import type { IWatch } from '@/types/watch';

const DB_PATH = path.join(os.homedir(), '.purplemux', 'mission-control.sqlite');
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const impactId = (workspaceId: string, runId: string, sourceKey: string): string =>
  `pb-${hash([workspaceId, runId, sourceKey]).slice(0, 32)}`;

interface IImpactRow {
  id: string;
  workspace_id: string;
  run_id: string;
  source_key: string;
  resource_key: string;
  revision: number;
  report_json: string;
  state: IPortfolioImpact['state'];
  first_blocked_at: number;
  updated_at: number;
  proof: string | null;
  note_id: string | null;
  escalated_at: number | null;
}

const impactFromRow = (row: IImpactRow): IPortfolioImpact => {
  const report = JSON.parse(row.report_json) as IPortfolioReport;
  const { eventId: _eventId, bindingGeneration: _bindingGeneration, producerAt: _producerAt, ...fields } = report;
  return {
    ...fields, id: row.id, state: row.state, firstBlockedAt: row.first_blocked_at,
    updatedAt: row.updated_at, proof: row.proof, noteId: row.note_id,
    noteState: null, noteDeliveredAt: null, escalatedAt: row.escalated_at,
  };
};

export class PortfolioStore {
  private readonly db: Database.Database;

  constructor(databasePath = DB_PATH) {
    if (databasePath === DB_PATH) getMissionControlStore();
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portfolio_selection (
        actor TEXT PRIMARY KEY, selection_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portfolio_impacts (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
        source_key TEXT NOT NULL, resource_key TEXT NOT NULL, revision INTEGER NOT NULL,
        report_json TEXT NOT NULL, state TEXT NOT NULL, first_blocked_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, proof TEXT, note_id TEXT, escalated_at INTEGER,
        UNIQUE(workspace_id,run_id,source_key)
      );
      CREATE INDEX IF NOT EXISTS portfolio_resource_idx ON portfolio_impacts(resource_key,state);
      CREATE TABLE IF NOT EXISTS portfolio_events (
        id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, impact_id TEXT NOT NULL,
        event_type TEXT NOT NULL, committed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portfolio_actions (
        id TEXT PRIMARY KEY, impact_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        expected_revision INTEGER NOT NULL, resource_key TEXT NOT NULL, actor TEXT NOT NULL,
        decision TEXT NOT NULL, note_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portfolio_wakes (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_key TEXT NOT NULL,
        watch_id TEXT NOT NULL, watch_owner_workspace_id TEXT NOT NULL,
        watch_owner_tab_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'watch',
        claim_json TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portfolio_escalations (
        id TEXT PRIMARY KEY, impact_id TEXT NOT NULL, checkpoint_at INTEGER NOT NULL,
        episode_started_at INTEGER NOT NULL, sent_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS portfolio_milestones (
        id TEXT PRIMARY KEY, input_hash TEXT NOT NULL, workspace_id TEXT NOT NULL,
        run_id TEXT NOT NULL, stage TEXT NOT NULL, source TEXT NOT NULL,
        evidence TEXT NOT NULL, actor TEXT, observed_at INTEGER NOT NULL
      );
    `);
  }

  close = (): void => { this.db.close(); };

  selection = (actor: string): IPortfolioSelection | null => {
    const row = this.db.prepare('SELECT selection_json FROM portfolio_selection WHERE actor=?').get(actor) as { selection_json: string } | undefined;
    return row ? JSON.parse(row.selection_json) as IPortfolioSelection : null;
  };

  currentSelection = (): { actor: string; selection: IPortfolioSelection; updatedAt: number } | null => {
    const row = this.db.prepare('SELECT actor,selection_json,updated_at FROM portfolio_selection ORDER BY updated_at DESC,actor DESC LIMIT 1')
      .get() as { actor: string; selection_json: string; updated_at: number } | undefined;
    return row ? { actor: row.actor, selection: JSON.parse(row.selection_json) as IPortfolioSelection,
      updatedAt: row.updated_at } : null;
  };

  select = (actor: string, selection: IPortfolioSelection): void => {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT MAX(updated_at) AS latest FROM portfolio_selection')
        .get() as { latest: number | null };
      const updatedAt = Math.max(Date.now(), (row.latest ?? 0) + 1);
      this.db.prepare(`INSERT INTO portfolio_selection (actor,selection_json,updated_at) VALUES (?,?,?)
        ON CONFLICT(actor) DO UPDATE SET selection_json=excluded.selection_json,updated_at=excluded.updated_at`)
        .run(actor, JSON.stringify(selection), updatedAt);
    }).immediate();
  };

  impacts = (): IPortfolioImpact[] =>
    (this.db.prepare('SELECT * FROM portfolio_impacts ORDER BY first_blocked_at,id').all() as IImpactRow[]).map(impactFromRow);

  impact = (id: string): IPortfolioImpact | null => {
    const row = this.db.prepare('SELECT * FROM portfolio_impacts WHERE id=?').get(id) as IImpactRow | undefined;
    return row ? impactFromRow(row) : null;
  };

  actions = (): IPortfolioAction[] =>
    (this.db.prepare('SELECT id,impact_id,actor,decision,note_id,state,created_at FROM portfolio_actions ORDER BY created_at DESC').all() as Array<{
      id: string; impact_id: string; actor: string; decision: string; note_id: string | null; state: string; created_at: number;
    }>).map((row) => ({ id: row.id, impactId: row.impact_id, actor: row.actor, decision: row.decision,
      noteId: row.note_id, state: row.state, createdAt: row.created_at }));

  milestones = (): IPortfolioMilestone[] =>
    (this.db.prepare('SELECT workspace_id,run_id,stage,source,evidence,actor,observed_at FROM portfolio_milestones ORDER BY observed_at').all() as Array<{
      workspace_id: string; run_id: string; stage: IPortfolioMilestone['stage'];
      source: IPortfolioMilestone['source']; evidence: string; actor: string | null; observed_at: number;
    }>).map((row) => ({ workspaceId: row.workspace_id, runId: row.run_id, stage: row.stage,
      source: row.source, evidence: row.evidence, actor: row.actor, observedAt: row.observed_at }));

  confirmMilestone = (event: { eventId: string; workspaceId: string; runId: string;
    stage: 'merged' | 'deployed' | 'verified'; evidence: string; observedAt: number }, actor: string): IPortfolioMilestone => this.db.transaction(() => {
    const inputHash = hash([event, actor]);
    const prior = this.db.prepare('SELECT input_hash FROM portfolio_milestones WHERE id=?').get(event.eventId) as
      { input_hash: string } | undefined;
    if (prior) {
      if (prior.input_hash !== inputHash) throw new MissionControlError(409, 'conflict', 'milestone event ID reused');
    } else {
      const existing = this.db.prepare('SELECT 1 FROM portfolio_impacts WHERE workspace_id=? AND run_id=? LIMIT 1')
        .get(event.workspaceId, event.runId);
      if (!existing) throw new MissionControlError(404, 'not-found', 'release not found in the selected workspace');
      this.db.prepare('INSERT INTO portfolio_milestones (id,input_hash,workspace_id,run_id,stage,source,evidence,actor,observed_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(event.eventId, inputHash, event.workspaceId, event.runId, event.stage, 'human-confirmed',
          event.evidence, actor, event.observedAt);
    }
    return { workspaceId: event.workspaceId, runId: event.runId, stage: event.stage,
      source: 'human-confirmed' as const, evidence: event.evidence, observedAt: event.observedAt, actor };
  })();

  report = (report: IPortfolioReport): { impact: IPortfolioImpact; replayed: boolean } => this.db.transaction(() => {
    const inputHash = hash(report);
    const priorEvent = this.db.prepare('SELECT input_hash,impact_id FROM portfolio_events WHERE id=?').get(report.eventId) as
      { input_hash: string; impact_id: string } | undefined;
    if (priorEvent) {
      if (priorEvent.input_hash !== inputHash) throw new MissionControlError(409, 'conflict', 'event ID reused with different content');
      const impact = this.impact(priorEvent.impact_id);
      if (!impact) throw new MissionControlError(503, 'storage-unavailable', 'portfolio event has no impact');
      return { impact, replayed: true };
    }
    const id = impactId(report.workspaceId, report.runId, report.sourceKey);
    const previous = this.db.prepare('SELECT * FROM portfolio_impacts WHERE id=?').get(id) as IImpactRow | undefined;
    if ((!previous && report.revision !== 0) || (previous && report.revision !== previous.revision + 1)) {
      throw new MissionControlError(409, 'conflict', `blocker revision ${report.revision} does not follow ${previous?.revision ?? -1}`);
    }
    if (previous && report.watchId && report.watchId === (JSON.parse(previous.report_json) as IPortfolioReport).watchId) {
      throw new MissionControlError(409, 'conflict', 'a newer blocker revision requires a new watch');
    }
    const now = Date.now();
    const updatedAt = Math.max(now, (previous?.updated_at ?? 0) + 1);
    const previousReport = previous ? JSON.parse(previous.report_json) as IPortfolioReport : null;
    const sameEpisode = !!previous && previous.state !== 'resolved'
      && previous.resource_key === report.resourceKey && previousReport?.kind === report.kind;
    const firstBlockedAt = sameEpisode ? previous.first_blocked_at : updatedAt;
    const keepEscalation = sameEpisode && previousReport?.checkpointAt === report.checkpointAt;
    this.db.prepare(`INSERT INTO portfolio_impacts
      (id,workspace_id,run_id,source_key,resource_key,revision,report_json,state,first_blocked_at,updated_at,proof,note_id,escalated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?)
      ON CONFLICT(id) DO UPDATE SET resource_key=excluded.resource_key,revision=excluded.revision,
      report_json=excluded.report_json,state=excluded.state,first_blocked_at=excluded.first_blocked_at,
      updated_at=excluded.updated_at,proof=NULL,note_id=excluded.note_id,escalated_at=excluded.escalated_at`)
      .run(id, report.workspaceId, report.runId, report.sourceKey, report.resourceKey, report.revision,
        JSON.stringify(report), sameEpisode ? previous.state : 'received', firstBlockedAt, updatedAt,
        sameEpisode ? previous.note_id : null, keepEscalation ? previous.escalated_at : null);
    this.db.prepare('INSERT INTO portfolio_events (id,input_hash,impact_id,event_type,committed_at) VALUES (?,?,?,?,?)')
      .run(report.eventId, inputHash, id, 'reported', now);
    return { impact: this.impact(id)!, replayed: false };
  })();

  acknowledge = (id: string, expectedRevision: number): IPortfolioImpact => this.db.transaction(() => {
    const prior = this.impact(id);
    if (!prior) throw new MissionControlError(404, 'not-found', 'blocker not found');
    if (prior.revision !== expectedRevision) throw new MissionControlError(409, 'conflict', 'blocker revision changed');
    if (prior.state === 'resolved') throw new MissionControlError(409, 'conflict', 'blocker already resolved');
    this.db.prepare("UPDATE portfolio_impacts SET state=CASE WHEN state='received' THEN 'acknowledged' ELSE state END WHERE id=?").run(id);
    return this.impact(id)!;
  })();

  reserveAction = (id: string, impactIdValue: string, expectedRevision: number, decision: string, actor: string):
    { state: string; noteId: string | null } => this.db.transaction(() => {
    const requestHash = hash([impactIdValue, expectedRevision, decision, actor]);
    const prior = this.db.prepare('SELECT * FROM portfolio_actions WHERE id=?').get(id) as
      { impact_id: string; request_hash: string; state: string; note_id: string | null; resource_key: string } | undefined;
    const impact = this.impact(impactIdValue);
    if (!impact) throw new MissionControlError(404, 'not-found', 'blocker not found');
    if (prior) {
      if (prior.request_hash !== requestHash) throw new MissionControlError(409, 'conflict', 'action ID reused with different content');
      if (prior.state === 'reserved' && (impact.revision !== expectedRevision || impact.state === 'resolved'
        || impact.resourceKey !== prior.resource_key)) {
        this.db.prepare("UPDATE portfolio_actions SET state='superseded' WHERE id=? AND state='reserved'").run(id);
        return { state: 'superseded', noteId: null };
      }
      if (prior.state === 'superseded') return { state: 'superseded', noteId: null };
      if (prior.state === 'sent' && impact.state !== 'resolved'
        && (impact.resourceKey !== prior.resource_key || impact.noteId !== prior.note_id)) {
        throw new MissionControlError(409, 'conflict', 'sent action no longer applies to this dependency');
      }
      return { state: prior.state, noteId: prior.note_id };
    }
    if (impact.revision !== expectedRevision || impact.state === 'resolved') {
      throw new MissionControlError(409, 'conflict', 'blocker changed before action');
    }
    this.db.prepare('INSERT INTO portfolio_actions (id,impact_id,request_hash,expected_revision,resource_key,actor,decision,note_id,state,created_at) VALUES (?,?,?,?,?,?,?,NULL,?,?)')
      .run(id, impactIdValue, requestHash, expectedRevision, impact.resourceKey, actor, decision, 'reserved', Date.now());
    return { state: 'reserved', noteId: null };
  })();

  completeAction = (actionId: string, noteId: string): IPortfolioImpact => this.db.transaction(() => {
    const action = this.db.prepare('SELECT impact_id,expected_revision,resource_key,state,note_id FROM portfolio_actions WHERE id=?').get(actionId) as
      { impact_id: string; expected_revision: number; resource_key: string; state: string; note_id: string | null } | undefined;
    if (!action) throw new MissionControlError(404, 'not-found', 'action not found');
    if (action.state === 'sent') {
      const current = this.impact(action.impact_id);
      if (!current || (current.state !== 'resolved' && (current.resourceKey !== action.resource_key
        || current.noteId !== action.note_id))) {
        throw new MissionControlError(409, 'conflict', 'sent action no longer applies to this dependency');
      }
      return current;
    }
    const impact = this.impact(action.impact_id);
    if (!impact || action.state !== 'reserved' || impact.revision !== action.expected_revision
      || impact.resourceKey !== action.resource_key || impact.state === 'resolved') {
      throw new MissionControlError(409, 'conflict', 'reserved action superseded before delivery completion');
    }
    this.db.prepare("UPDATE portfolio_actions SET state='sent',note_id=? WHERE id=? AND state='reserved'").run(noteId, actionId);
    this.db.prepare("UPDATE portfolio_impacts SET state='action-assigned',note_id=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND revision=? AND state!='resolved'")
      .run(noteId, Date.now(), action.impact_id, action.expected_revision);
    return this.impact(action.impact_id)!;
  })();

  /** NotesService checks this again at routing and composer preflight, including after restart. */
  actionNoteDeliverable = (actionId: string, noteId: string, workspaceId: string): boolean => {
    const action = this.db.prepare('SELECT impact_id,expected_revision,resource_key,state,note_id FROM portfolio_actions WHERE id=?').get(actionId) as
      { impact_id: string; expected_revision: number; resource_key: string; state: string; note_id: string | null } | undefined;
    if (!action || !['reserved', 'sent'].includes(action.state)) return false;
    const impact = this.impact(action.impact_id);
    if (!impact || impact.workspaceId !== workspaceId || impact.resourceKey !== action.resource_key
      || impact.state === 'resolved') return false;
    return action.state === 'reserved' ? impact.revision === action.expected_revision
      : action.note_id === noteId && impact.noteId === noteId;
  };

  markApplied = (id: string, noteId: string, eventId: string, expectedRevision: number): IPortfolioImpact => this.db.transaction(() => {
    const inputHash = hash([id, noteId, expectedRevision]);
    const prior = this.db.prepare('SELECT input_hash,impact_id FROM portfolio_events WHERE id=?').get(eventId) as
      { input_hash: string; impact_id: string } | undefined;
    if (prior) {
      if (prior.input_hash !== inputHash || prior.impact_id !== id) {
        throw new MissionControlError(409, 'conflict', 'application event ID reused with different content');
      }
      const replay = this.impact(id);
      if (!replay) throw new MissionControlError(503, 'storage-unavailable', 'application event has no impact');
      return replay;
    }
    const impact = this.impact(id);
    if (!impact) throw new MissionControlError(404, 'not-found', 'blocker not found');
    if (expectedRevision > impact.revision || impact.state === 'resolved') {
      throw new MissionControlError(409, 'conflict', 'stale blocker revision');
    }
    if (impact.noteId !== noteId) throw new MissionControlError(409, 'conflict', 'action note changed');
    this.db.prepare("UPDATE portfolio_impacts SET state='waiting',updated_at=MAX(updated_at+1,?) WHERE id=? AND state='action-assigned'")
      .run(Date.now(), id);
    this.db.prepare('INSERT INTO portfolio_events (id,input_hash,impact_id,event_type,committed_at) VALUES (?,?,?,?,?)')
      .run(eventId, inputHash, id, 'action-applied', Date.now());
    return this.impact(id)!;
  })();

  resolveCapacity = (event: IPortfolioResolution): IPortfolioImpact => this.db.transaction(() => {
    const inputHash = hash(event);
    const prior = this.db.prepare('SELECT input_hash,impact_id FROM portfolio_events WHERE id=?').get(event.eventId) as
      { input_hash: string; impact_id: string } | undefined;
    if (prior) {
      if (prior.input_hash !== inputHash || prior.impact_id !== event.impactId) {
        throw new MissionControlError(409, 'conflict', 'resolution event ID reused with different content');
      }
      const replay = this.impact(event.impactId);
      if (!replay) throw new MissionControlError(503, 'storage-unavailable', 'resolution event has no impact');
      return replay;
    }
    const impact = this.impact(event.impactId);
    if (!impact || impact.workspaceId !== event.workspaceId || impact.runId !== event.runId) {
      throw new MissionControlError(404, 'not-found', 'blocker not found in this run');
    }
    if (!['worker-limit', 'build-slots', 'memory', 'disk-reservation'].includes(impact.kind) || impact.watchId) {
      throw new MissionControlError(400, 'invalid-request', 'only supplied unwatched capacity blockers use this resolution event');
    }
    if (impact.revision !== event.expectedRevision || impact.state === 'resolved') {
      throw new MissionControlError(409, 'conflict', 'blocker changed before capacity proof');
    }
    const blockedObservation = (this.db.prepare('SELECT report_json FROM portfolio_impacts WHERE id=?').get(impact.id) as
      { report_json: string }).report_json;
    if (event.observedAt < (JSON.parse(blockedObservation) as IPortfolioReport).producerAt) {
      throw new MissionControlError(409, 'conflict', 'capacity proof predates the current blocked observation');
    }
    if (impact.capacity?.host !== event.evidence.host
      || (impact.capacity.clearingCondition && impact.capacity.clearingCondition !== event.evidence.clearingCondition)) {
      throw new MissionControlError(400, 'invalid-request', 'capacity proof must match the blocked host and clearing condition');
    }
    const proof = JSON.stringify({ source: 'coordinator-capacity', eventId: event.eventId,
      observedAt: event.observedAt, evidence: event.evidence });
    this.db.prepare("UPDATE portfolio_impacts SET state='resolved',proof=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND revision=? AND state!='resolved'")
      .run(proof, Date.now(), impact.id, event.expectedRevision);
    this.db.prepare('INSERT INTO portfolio_events (id,input_hash,impact_id,event_type,committed_at) VALUES (?,?,?,?,?)')
      .run(event.eventId, inputHash, impact.id, 'capacity-resolved', Date.now());
    const otherWorkspaces = this.db.prepare("SELECT DISTINCT workspace_id FROM portfolio_impacts WHERE resource_key=? AND state!='resolved' AND workspace_id!=?")
      .all(impact.resourceKey, impact.workspaceId) as Array<{ workspace_id: string }>;
    const claim = JSON.stringify({ observedAt: event.observedAt });
    for (const { workspace_id: workspaceId } of otherWorkspaces) {
      const wakeId = `pw-${hash(['capacity', event.eventId, workspaceId]).slice(0, 24)}`;
      this.db.prepare(`INSERT OR IGNORE INTO portfolio_wakes
        (id,workspace_id,resource_key,watch_id,watch_owner_workspace_id,watch_owner_tab_id,source,claim_json,state,created_at)
        VALUES (?,?,?,?,?,?,'capacity-claim',?,'pending',?)`)
        .run(wakeId, workspaceId, impact.resourceKey, event.eventId, impact.workspaceId, '', claim, Date.now());
    }
    return this.impact(impact.id)!;
  })();

  clearByWatch = (watch: IWatch, fields: Record<string, unknown>): IPortfolioImpact[] => this.db.transaction(() => {
    const valid = (watch.kind === 'lease' && fields.notice === 'free')
      || (watch.kind === 'pr' && fields.notice === 'merged')
      || (watch.kind === 'pr' && fields.notice === 'checks-settled'
        && typeof fields.successful === 'number' && fields.successful > 0 && fields.red === 0)
      || (watch.kind === 'ref' && fields.notice === 'moved');
    if (!valid) return [];
    const rows = this.db.prepare("SELECT * FROM portfolio_impacts WHERE state!='resolved'").all() as IImpactRow[];
    const matches = rows.filter((row) => {
      const report = JSON.parse(row.report_json) as IPortfolioReport;
      return report.watchId === watch.id && report.resourceKey === `${watch.kind}:${watch.target}`
        && (watch.kind === 'lease' || (report.watchHead !== null && (watch.kind === 'ref'
          ? fields.fromSha === report.watchHead && fields.sha !== report.watchHead
          : fields.sha === report.watchHead)));
    });
    const proof = JSON.stringify({ source: 'watch', watchId: watch.id, target: watch.target, notice: fields.notice,
      sha: typeof fields.sha === 'string' ? fields.sha : null, observedAt: Date.now() });
    for (const row of matches) {
      this.db.prepare("UPDATE portfolio_impacts SET state='resolved',proof=?,updated_at=MAX(updated_at+1,?) WHERE id=? AND state!='resolved'")
        .run(proof, Date.now(), row.id);
    }
    for (const workspaceId of new Set(matches.map((row) => row.workspace_id))) {
      const wakeId = `pw-${hash([watch.id, workspaceId]).slice(0, 24)}`;
      this.db.prepare(`INSERT OR IGNORE INTO portfolio_wakes
        (id,workspace_id,resource_key,watch_id,watch_owner_workspace_id,watch_owner_tab_id,state,created_at)
        VALUES (?,?,?,?,?,?,'pending',?)`)
        .run(wakeId, workspaceId, `${watch.kind}:${watch.target}`, watch.id, watch.workspaceId, watch.tabId, Date.now());
    }
    return matches.map((row) => this.impact(row.id)!);
  })();

  pendingWakes = (): Array<{ id: string; workspaceId: string; resourceKey: string; watchId: string;
    watchOwnerWorkspaceId: string; watchOwnerTabId: string; source: 'watch' | 'capacity-claim'; claim: string | null }> =>
    (this.db.prepare("SELECT * FROM portfolio_wakes WHERE state='pending' ORDER BY created_at,id LIMIT 100").all() as Array<{
      id: string; workspace_id: string; resource_key: string; watch_id: string;
      watch_owner_workspace_id: string; watch_owner_tab_id: string; source: 'watch' | 'capacity-claim'; claim_json: string | null;
    }>).map((row) => ({ id: row.id, workspaceId: row.workspace_id, resourceKey: row.resource_key,
      watchId: row.watch_id, watchOwnerWorkspaceId: row.watch_owner_workspace_id, watchOwnerTabId: row.watch_owner_tab_id,
      source: row.source, claim: row.claim_json }));

  markWakeSent = (id: string): void => {
    this.db.prepare("UPDATE portfolio_wakes SET state='sent' WHERE id=? AND state='pending'").run(id);
  };

  dueCheckpoints = (now: number): IPortfolioImpact[] =>
    this.impacts().filter((impact) => impact.state !== 'resolved' && impact.checkpointAt !== null
      && impact.checkpointAt < now && impact.escalatedAt === null
      && !this.db.prepare('SELECT 1 FROM portfolio_escalations WHERE id=?')
        .get(this.escalationKey(impact)));

  escalationKey = (impact: IPortfolioImpact): string =>
    `pe-${hash([impact.id, impact.firstBlockedAt, impact.checkpointAt]).slice(0, 32)}`;

  markEscalated = (id: string, revision: number, now: number): boolean =>
    this.db.transaction(() => {
      const impact = this.impact(id);
      if (!impact || impact.revision !== revision || impact.state === 'resolved' || impact.checkpointAt === null) return false;
      const key = this.escalationKey(impact);
      this.db.prepare('INSERT OR IGNORE INTO portfolio_escalations (id,impact_id,checkpoint_at,episode_started_at,sent_at) VALUES (?,?,?,?,?)')
        .run(key, id, impact.checkpointAt, impact.firstBlockedAt, now);
      return this.db.prepare('UPDATE portfolio_impacts SET escalated_at=? WHERE id=? AND revision=? AND escalated_at IS NULL AND state!=?')
        .run(now, id, revision, 'resolved').changes > 0;
    })();
}

const g = globalThis as unknown as { __ptPortfolioStore?: PortfolioStore };
export const getPortfolioStore = (): PortfolioStore => {
  if (!g.__ptPortfolioStore) g.__ptPortfolioStore = new PortfolioStore();
  return g.__ptPortfolioStore;
};
