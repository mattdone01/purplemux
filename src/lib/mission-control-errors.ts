import type { IMissionAttentionItem, IMissionRun } from '@/types/mission-control';

export type TMissionErrorCode =
  | 'invalid-request'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'storage-unavailable';

export class MissionControlError extends Error {
  readonly status: number;
  readonly code: TMissionErrorCode;
  readonly current?: IMissionAttentionItem | IMissionRun;

  constructor(
    status: number,
    code: TMissionErrorCode,
    message: string,
    current?: IMissionAttentionItem | IMissionRun,
  ) {
    super(message);
    this.name = 'MissionControlError';
    this.status = status;
    this.code = code;
    this.current = current;
  }
}

export const invalidMissionRequest = (message: string): never => {
  throw new MissionControlError(400, 'invalid-request', message);
};

export const missionConflict = (
  message: string,
  current?: IMissionAttentionItem | IMissionRun,
): never => {
  throw new MissionControlError(409, 'conflict', message, current);
};

export const missionNotFound = (message: string): never => {
  throw new MissionControlError(404, 'not-found', message);
};
