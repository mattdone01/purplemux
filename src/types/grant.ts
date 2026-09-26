// Portfolio drive grants (ADR-0014): a human lets ONE verified tab drive other workspaces for a while.

export interface IGrantParty {
  workspaceId: string;
  tabId: string;
}

export type TGrantEndReason = 'revoked' | 'grantee-tab-closed' | 'expired';

export interface IGrant {
  id: string;
  capability: 'drive';
  grantee: IGrantParty;
  /** The workspaces the grantee may drive (never its own: it drives that already). */
  workspaces: string[];
  reason: string;
  createdAt: number;
  /** The human session subject that granted it. */
  createdBy: string;
  expiresAt: number;
  revokedAt: number | null;
  /** The human session subject, or `system` for a grantee tab that closed. */
  revokedBy: string | null;
  revokeReason: TGrantEndReason | null;
  /** When the expiry was audited (once). */
  expiryNotedAt: number | null;
}

export interface IGrantsState {
  grants: IGrant[];
}

export type TGrantErrorCode =
  | 'grant-invalid'
  | 'grant-not-found'
  | 'grant-tab-unverified'
  | 'grant-password-invalid'
  | 'grant-locked'
  | 'grant-store-unreadable';
