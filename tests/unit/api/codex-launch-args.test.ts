import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const codex = vi.hoisted(() => ({ buildCodexRuntimeArgs: vi.fn() }));
const lifecycle = vi.hoisted(() => ({ resolveCodexLaunchIntent: vi.fn() }));
const cli = vi.hoisted(() => ({ authorizeWorkspaceInput: vi.fn() }));

vi.mock('@/lib/providers/codex', () => codex);
vi.mock('@/lib/providers/codex/launch-lifecycle', () => lifecycle);
vi.mock('@/lib/cli-utils', () => cli);
vi.mock('@/lib/workspace-store', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-active') }));

interface IFakeResponse {
  statusCode: number;
  body: unknown;
  res: NextApiResponse;
}

const fakeResponse = (): IFakeResponse => {
  const state: IFakeResponse = {
    statusCode: 0,
    body: undefined,
    res: undefined as unknown as NextApiResponse,
  };
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
  } as unknown as NextApiResponse;
  return state;
};

describe('POST /api/codex/launch-args', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codex.buildCodexRuntimeArgs.mockResolvedValue([
      '--model',
      'gpt-6-astra',
      '-c',
      'model_reasoning_effort=medium',
    ]);
    lifecycle.resolveCodexLaunchIntent.mockResolvedValue({
      resumeSessionId: '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      launchedConfig: { model: 'gpt-5.6-sol', effort: 'high' },
    });
    cli.authorizeWorkspaceInput.mockResolvedValue({ type: 'workspace', workspaceId: 'ws-pins' });
  });

  it('resolves managed runtime args from the immutable generation instead of request overrides', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-args');
    const response = fakeResponse();
    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'workspace-token' },
      body: {
        workspaceId: 'ws-pins',
        tabId: 'tab-pins',
        sessionName: 'pt-ws-pins-pane-one-tab-pins',
        generation: 'codex-generation',
        model: 'attacker-override',
        effort: 'minimal',
      },
    } as unknown as NextApiRequest, response.res);
    expect(lifecycle.resolveCodexLaunchIntent).toHaveBeenCalledWith(
      'ws-pins', 'tab-pins', 'codex-generation', 'pt-ws-pins-pane-one-tab-pins',
    );
    expect(codex.buildCodexRuntimeArgs).toHaveBeenCalledWith(
      'ws-pins',
      '01a008c1-bb96-71d1-9769-b63ff478fd9f',
      { model: 'gpt-5.6-sol', effort: 'high' },
    );
    expect(response.statusCode).toBe(200);
  });

  it('does not resolve managed args when input authorization fails', async () => {
    cli.authorizeWorkspaceInput.mockResolvedValue(null);
    const { default: handler } = await import('@/pages/api/codex/launch-args');
    const response = fakeResponse();
    await handler({
      method: 'POST',
      headers: { 'x-pmux-token': 'wrong-token' },
      body: {
        workspaceId: 'ws-pins',
        tabId: 'tab-pins',
        sessionName: 'pt-ws-pins-pane-one-tab-pins',
        generation: 'codex-generation',
      },
    } as unknown as NextApiRequest, response.res);
    expect(lifecycle.resolveCodexLaunchIntent).not.toHaveBeenCalled();
    expect(codex.buildCodexRuntimeArgs).not.toHaveBeenCalled();
  });

  it('forwards wrapper model and effort into the runtime arg builder', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-args');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      body: {
        workspaceId: 'ws-pins',
        model: 'gpt-6-astra',
        effort: 'medium',
      },
    } as NextApiRequest, response.res);

    expect(codex.buildCodexRuntimeArgs).toHaveBeenCalledWith('ws-pins', undefined, {
      model: 'gpt-6-astra',
      effort: 'medium',
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      args: ['--model', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium'],
    });
  });

  it('preserves the configured defaults when model and effort are omitted', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-args');
    const response = fakeResponse();

    await handler({ method: 'POST', body: { workspaceId: 'ws-pins' } } as NextApiRequest, response.res);

    expect(codex.buildCodexRuntimeArgs).toHaveBeenCalledWith('ws-pins', undefined, {
      model: undefined,
      effort: undefined,
    });
    expect(response.statusCode).toBe(200);
  });

  it('preserves defaults when the request has no body', async () => {
    const { default: handler } = await import('@/pages/api/codex/launch-args');
    const response = fakeResponse();

    await handler({ method: 'POST' } as NextApiRequest, response.res);

    expect(codex.buildCodexRuntimeArgs).toHaveBeenCalledWith('ws-active', undefined, {
      model: undefined,
      effort: undefined,
    });
    expect(response.statusCode).toBe(200);
  });

  it.each([
    ['model', ''],
    ['model', 42],
    ['model', null],
    ['effort', 'ultra'],
    ['effort', ''],
    ['effort', 42],
  ])('rejects an explicit invalid %s value (%j)', async (field, value) => {
    const { default: handler } = await import('@/pages/api/codex/launch-args');
    const response = fakeResponse();

    await handler({
      method: 'POST',
      body: { workspaceId: 'ws-pins', [field]: value },
    } as NextApiRequest, response.res);

    expect(response.statusCode).toBe(400);
    expect(codex.buildCodexRuntimeArgs).not.toHaveBeenCalled();
  });
});
