/** Why a tab is told about a restart: it orchestrates its workspace, or it holds a tab-bound lease. */
export type TDeployRecipientReason = 'orchestrator' | `lease ${string}`;

export interface IDeployRecipient {
  workspaceId: string;
  tabId: string;
  reasons: TDeployRecipientReason[];
  /** The inbox item that carries the notice (ADR-0012). */
  itemId: string;
}

export interface IDeployAnnouncement {
  /** `d-<nanoid>`. */
  id: string;
  /** Caller text, ≤ 120 characters: shown by `deploy status`, never typed into a tab. */
  reason: string;
  inMinutes: number;
  createdAt: number;
  restartAt: number;
  by: { workspaceId: string | null; tabId: string | null; admin: boolean };
  recipients: IDeployRecipient[];
}

export interface IDeployAnnouncementsState {
  announcements: IDeployAnnouncement[];
}

export type TDeployDelivery = 'queued' | 'delivered' | 'held' | 'dropped' | 'pruned';

export interface IDeployRecipientStatus extends Omit<IDeployRecipient, 'itemId'> {
  itemId: string;
  /** The inbox item's state; `pruned` when the inbox no longer has it. */
  state: TDeployDelivery;
  cliState: string | null;
}

export type TDeployErrorCode = 'deploy-invalid' | 'deploy-not-found' | 'forbidden';
