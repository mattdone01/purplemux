export interface ILeaseHolder {
  workspaceId: string | null;
  tabId: string | null;
  tabName: string | null;
  verified: boolean;
  /** The global token. Shown as `admin`, never as a human (ADR-0010). */
  admin: boolean;
}

export interface ILease {
  name: string;
  kind: string;
  resource: string;
  holder: ILeaseHolder;
  epic: string | null;
  note: string | null;
  acquiredAt: string;
  renewedAt: string;
  ttlSeconds: number | null;
  expiresAt: string | null;
  survivesTab: boolean;
}

export interface ILeaseState {
  leases: ILease[];
}

export type THolderState = 'live' | 'agent-gone' | 'closed' | 'admin';

export interface ILeaseView extends Omit<ILease, 'holder'> {
  holder: ILeaseHolder & { workspaceName: string | null };
  ageSeconds: number;
  expiresInSeconds: number | null;
  holderState: THolderState;
}

export type TLeaseReleaseReason =
  | 'released'
  | 'broken'
  | 'release-epic'
  | 'expired'
  | 'holder-tab-closed'
  | 'holder-tab-gone'
  | 'holder-agent-gone';

export type TLeaseErrorCode =
  | 'lease-policy'
  | 'lease-held'
  | 'lease-held-by-other'
  | 'lease-not-found'
  | 'caller-unresolved'
  | 'forbidden';
