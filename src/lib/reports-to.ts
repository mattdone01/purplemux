import { findTab } from '@/lib/cli-utils';
import { hasSession } from '@/lib/tmux';
import { isAgentPanelType } from '@/lib/agent-panel-types';
import { parseReportOn, type TTurnMarkerName } from '@/lib/turn-end';

export interface IReportsToInvalid {
  error: string;
  code: 'reports-to-invalid';
  reportsTo: unknown;
}

const invalid = (reportsTo: unknown, error: string): IReportsToInvalid => ({ error, code: 'reports-to-invalid', reportsTo });

/**
 * A `reportsTo` target must be a live tab of the SAME workspace (research Q15):
 * nudges are typed into the target, and crossing a workspace here would widen
 * who may drive whom (ADR-0014 owns that). Null means valid.
 */
export const checkReportsTo = async (
  workspaceId: string,
  reportsTo: unknown,
  selfTabId?: string,
): Promise<IReportsToInvalid | null> => {
  if (typeof reportsTo !== 'string' || !reportsTo.trim()) return invalid(reportsTo, 'reportsTo must be a tab id');
  if (reportsTo === selfTabId) return invalid(reportsTo, 'a tab cannot report to itself');
  const found = await findTab(workspaceId, reportsTo);
  if (!found) return invalid(reportsTo, `reportsTo ${reportsTo} is not a tab of workspace ${workspaceId}`);
  // Nudges are typed and submitted: a shell or a browser would run them.
  if (!isAgentPanelType(found.tab.panelType)) return invalid(reportsTo, `reportsTo ${reportsTo} is not an agent tab`);
  if (!(await hasSession(found.tab.sessionName))) return invalid(reportsTo, `reportsTo ${reportsTo} is not a live tab`);
  return null;
};

export interface IReportOnInvalid {
  error: string;
  code: 'report-on-invalid';
  reportOn: unknown;
}

/**
 * `reportOn` (ADR-0025): the markers whose end lines reach the target, or null
 * for all. Refused with `report-on-invalid` (CLI exit 2) when a name is unknown
 * or the set is empty.
 */
export const checkReportOn = (reportOn: unknown): { markers: TTurnMarkerName[] | null } | IReportOnInvalid => {
  const parsed = parseReportOn(reportOn);
  if (parsed.ok) return { markers: parsed.markers };
  return { error: parsed.error, code: 'report-on-invalid', reportOn };
};

export const isReportOnInvalid = (checked: ReturnType<typeof checkReportOn>): checked is IReportOnInvalid => 'code' in checked;
