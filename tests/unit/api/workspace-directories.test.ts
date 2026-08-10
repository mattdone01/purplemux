import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import handler from '@/pages/api/workspace/[workspaceId]';
import { parseDirectoriesPatch } from '@/lib/workspace-patch';
import {
  getWorkspaceById,
  updateWorkspaceDirectories,
  validateDirectory,
} from '@/lib/workspace-store';

vi.mock('@/lib/workspace-store', () => ({
  deleteWorkspace: vi.fn(),
  getWorkspaceById: vi.fn(),
  renameWorkspace: vi.fn(),
  setWorkspaceGroup: vi.fn(),
  updateWorkspaceDirectories: vi.fn(),
  updateWorkspaceOrchestration: vi.fn(),
  validateDirectory: vi.fn(),
}));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = { statusCode: 0, body: undefined, res: undefined as unknown as NextApiResponse };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      state.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as NextApiResponse;
  return state;
};

const patchRequest = (body: unknown): NextApiRequest =>
  ({ method: 'PATCH', query: { workspaceId: 'ws-test' }, body }) as unknown as NextApiRequest;

describe('parseDirectoriesPatch', () => {
  it('accepts a non-empty array of paths and trims entries', () => {
    expect(parseDirectoriesPatch([' /a ', '/b'])).toEqual(['/a', '/b']);
  });

  it('rejects non-arrays, empty arrays, and blank or non-string entries', () => {
    expect(parseDirectoriesPatch('/a')).toBeNull();
    expect(parseDirectoriesPatch([])).toBeNull();
    expect(parseDirectoriesPatch(['/a', '  '])).toBeNull();
    expect(parseDirectoriesPatch(['/a', 42])).toBeNull();
  });
});

describe('PATCH /api/workspace/[workspaceId] directories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateDirectory).mockResolvedValue({ valid: true });
    vi.mocked(updateWorkspaceDirectories).mockResolvedValue(true);
    vi.mocked(getWorkspaceById).mockResolvedValue({ id: 'ws-test', name: 'test', directories: ['/a'] });
  });

  it('updates directories and returns the workspace', async () => {
    const { statusCode, body } = await run({ directories: ['/a', '/b'] });
    expect(updateWorkspaceDirectories).toHaveBeenCalledWith('ws-test', ['/a', '/b']);
    expect(statusCode).toBe(200);
    expect(body).toMatchObject({ id: 'ws-test' });
  });

  it('rejects invalid payloads with 400', async () => {
    const { statusCode } = await run({ directories: [] });
    expect(statusCode).toBe(400);
    expect(updateWorkspaceDirectories).not.toHaveBeenCalled();
  });

  it('rejects non-existent paths with 400', async () => {
    vi.mocked(validateDirectory).mockResolvedValue({ valid: false, error: 'Directory does not exist' });
    const { statusCode, body } = await run({ directories: ['/nope'] });
    expect(statusCode).toBe(400);
    expect(body).toMatchObject({ error: '/nope: Directory does not exist' });
  });

  it('maps a primary-directory conflict to 409', async () => {
    vi.mocked(updateWorkspaceDirectories).mockRejectedValue(new Error('primary directories must be unique'));
    const { statusCode, body } = await run({ directories: ['/a'] });
    expect(statusCode).toBe(409);
    expect(body).toMatchObject({ error: 'primary directories must be unique' });
  });

  it('returns 404 for an unknown workspace', async () => {
    vi.mocked(updateWorkspaceDirectories).mockResolvedValue(false);
    const { statusCode } = await run({ directories: ['/a'] });
    expect(statusCode).toBe(404);
  });

  const run = async (body: unknown): Promise<IFakeResponse> => {
    const state = fakeResponse();
    await handler(patchRequest(body), state.res);
    return state;
  };
});
