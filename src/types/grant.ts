// Portfolio grants (ADR-0014): a human lets ONE verified tab read other workspaces for a while.
// An `owner` grant (ADR-0029) reads every workspace and sends notes as the owner; it lives in its own file.

export interface IGrantParty {
  workspaceId: string;
  tabId: string;
}

export type TGrantEndReason = 'revoked' | 'grantee-tab-closed' | 'expired';

export type TGrantCapability = 'drive' | 'owner';

export interface IGrant {
  id: string;
  capability: TGrantCapability;
  grantee: IGrantParty;
  /** The workspaces the grantee may read (never its own); `['*']` exactly on an `owner` grant, never on a `drive` one. */
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

/** A tab the web dialog lists as a possible grantee (story 28). */
export interface IGrantee {
  workspaceId: string;
  workspaceName: string;
  tabId: string;
  name: string;
  panelType: string;
  /** Only `launch` may hold a grant (ADR-0014). */
  identity: 'launch' | 'hook' | 'none';
}

export interface IGrantsState {
  grants: IGrant[];
}

/**
 * A grant file the server could not read (ADR-0029 §1): none of its grants is honoured, and a
 * listing names it instead of showing that kind as "no grants".
 */
export interface IGrantRefusal {
  capability: TGrantCapability;
  /** Basename only; `error` holds the full path. */
  file: 'grants.json' | 'owner-grants.json';
  error: string;
  code: 'grant-store-unreadable';
}

export type TGrantErrorCode =
  | 'grant-invalid'
  | 'grant-not-found'
  | 'grant-tab-unverified'
  | 'grant-password-invalid'
  | 'grant-locked'
  | 'grant-store-unreadable'
  | 'grant-owner-active';
