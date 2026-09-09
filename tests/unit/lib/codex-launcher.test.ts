import fs from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockHome = vi.hoisted(() => ({ value: '' }));
const state = vi.hoisted(() => ({ skipPermissions: false, hookArgs: [] as string[] }));

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => mockHome.value },
    homedir: () => mockHome.value,
  };
});

vi.mock('@/lib/config-store', () => ({
  getDangerouslySkipPermissions: async () => state.skipPermissions,
}));

vi.mock('@/lib/providers/codex/hook-config', () => ({
  buildCodexHookFlags: async () => ({ args: [...state.hookArgs] }),
}));

const importProvider = async () => {
  vi.resetModules();
  return import('@/lib/providers/codex');
};

beforeEach(async () => {
  mockHome.value = await fs.mkdtemp(path.join(os.tmpdir(), 'pmux-codex-launch-'));
  state.skipPermissions = false;
  state.hookArgs = [];
});

interface ILauncherResult {
  requestBody: unknown;
  exitCode: number | null;
  stderr: string;
  codexArgs: string[] | null;
}

const executeLauncher = async (
  launcherContent: string,
  wrapperArgs: string[],
  response: { status: number; args?: string[] },
): Promise<ILauncherResult> => {
  const baseDir = path.join(mockHome.value, '.purplemux');
  const binDir = path.join(mockHome.value, 'bin');
  const launcherPath = path.join(baseDir, 'codex-launcher.js');
  const capturePath = path.join(mockHome.value, 'codex-args.json');
  const fakeCodexPath = path.join(binDir, 'codex');
  await fs.mkdir(baseDir, { recursive: true });
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(launcherPath, launcherContent, { mode: 0o700 });
  await fs.writeFile(
    fakeCodexPath,
    `#!${process.execPath}\nrequire('fs').writeFileSync(process.env.CODEX_ARGS_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`,
    { mode: 0o700 },
  );

  let requestBody: unknown;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(response.status === 200
        ? JSON.stringify({ args: response.args ?? [] })
        : JSON.stringify({ error: 'Invalid model' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  await fs.writeFile(path.join(baseDir, 'port'), String(address.port));

  let stderr = '';
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [launcherPath, ...wrapperArgs], {
        env: {
          ...process.env,
          HOME: mockHome.value,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          CODEX_ARGS_CAPTURE: capturePath,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', resolve);
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }

  const captured = await fs.readFile(capturePath, 'utf8').catch(() => null);
  return {
    requestBody,
    exitCode,
    stderr,
    codexArgs: captured ? JSON.parse(captured) as string[] : null,
  };
};

describe('codex launch command', () => {
  it('keeps an unpinned launch on the wrapper defaults', async () => {
    const { codexProvider } = await importProvider();

    const command = await codexProvider.buildLaunchCommand({ workspaceId: 'ws-1' });

    expect(command).toBe(`node '${mockHome.value}/.purplemux/codex-launcher.js' --workspace-id 'ws-1'`);
  });

  it.each([
    ['gpt-6-astra', 'medium'],
    ['gpt-5.6-sol', 'high'],
  ])('passes %s with %s through the wrapper to the spawned Codex args', async (model, effort) => {
    const { CODEX_LAUNCHER_SCRIPT_CONTENT, buildCodexRuntimeArgs, codexProvider } = await importProvider();
    const expectedArgs = await buildCodexRuntimeArgs(undefined, undefined, { model, effort });
    expect(expectedArgs).toEqual(['--model', model, '-c', `model_reasoning_effort=${effort}`]);

    const command = await codexProvider.buildLaunchCommand({ workspaceId: 'ws-pins', model, effort });
    expect(command).toContain(`--model '${model}' --effort '${effort}'`);

    const result = await executeLauncher(CODEX_LAUNCHER_SCRIPT_CONTENT, [
      '--workspace-id',
      'ws-pins',
      '--model',
      model,
      '--effort',
      effort,
    ], { status: 200, args: expectedArgs });

    expect(result.exitCode).toBe(0);
    expect(result.requestBody).toEqual({
      workspaceId: 'ws-pins',
      resumeSessionId: null,
      model,
      effort,
    });
    expect(result.codexArgs).toEqual(expectedArgs);
  });

  it('preserves pins, hooks, developer instructions, and permissions when resuming', async () => {
    state.skipPermissions = true;
    state.hookArgs = ['-c', 'hooks.SessionStart=[{hooks=[]}]'];
    const { CODEX_LAUNCHER_SCRIPT_CONTENT, buildCodexRuntimeArgs, codexProvider } = await importProvider();
    const sessionId = '01a008c1-bb96-71d1-9769-b63ff478fd9f';
    const promptPath = path.join(mockHome.value, '.purplemux', 'workspaces', 'ws-1', 'codex-prompt.md');
    await fs.mkdir(path.dirname(promptPath), { recursive: true });
    await fs.writeFile(promptPath, 'worker instructions');

    const command = await codexProvider.buildResumeCommand(sessionId, {
      workspaceId: 'ws-1',
      model: 'gpt-5.6-sol',
      effort: 'high',
    });

    expect(command).toContain(`--resume-session-id '${sessionId}'`);
    expect(command).toContain("--model 'gpt-5.6-sol' --effort 'high'");

    const expectedArgs = await buildCodexRuntimeArgs('ws-1', sessionId, {
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(expectedArgs).toEqual([
      'resume',
      sessionId,
      '--model',
      'gpt-5.6-sol',
      '-c',
      'model_reasoning_effort=high',
      '-c',
      'hooks.SessionStart=[{hooks=[]}]',
      '-c',
      'developer_instructions="worker instructions"',
      '--yolo',
    ]);

    const result = await executeLauncher(CODEX_LAUNCHER_SCRIPT_CONTENT, [
      '--workspace-id',
      'ws-1',
      '--resume-session-id',
      sessionId,
      '--model',
      'gpt-5.6-sol',
      '--effort',
      'high',
    ], { status: 200, args: expectedArgs });
    expect(result.exitCode).toBe(0);
    expect(result.requestBody).toEqual({
      workspaceId: 'ws-1',
      resumeSessionId: sessionId,
      model: 'gpt-5.6-sol',
      effort: 'high',
    });
    expect(result.codexArgs).toEqual(expectedArgs);
  });

  it('rejects invalid model and effort values at both wrapper and runtime boundaries', async () => {
    const { CODEX_LAUNCHER_SCRIPT_CONTENT, buildCodexRuntimeArgs, codexProvider } = await importProvider();

    await expect(codexProvider.buildLaunchCommand({ model: '' })).rejects.toThrow('Invalid Codex model');
    await expect(buildCodexRuntimeArgs(undefined, undefined, { model: '' })).rejects.toThrow('Invalid Codex model');
    await expect(codexProvider.buildLaunchCommand({ effort: 'ultra' })).rejects.toThrow('Invalid Codex reasoning effort');
    await expect(buildCodexRuntimeArgs(undefined, undefined, { effort: 'ultra' }))
      .rejects.toThrow('Invalid Codex reasoning effort');

    const result = await executeLauncher(CODEX_LAUNCHER_SCRIPT_CONTENT, [
      '--model',
      'bad model; exit 1',
      '--effort',
      'medium',
    ], { status: 400 });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('failed to get Codex launch args: HTTP 400');
    expect(result.codexArgs).toBeNull();
  });

  it.each([
    [['--model'], '--model requires a value'],
    [['--effort'], '--effort requires a value'],
    [['--model', '--effort', 'high'], '--model requires a value'],
  ])('rejects wrapper pins with missing values: %j', async (wrapperArgs, error) => {
    const { CODEX_LAUNCHER_SCRIPT_CONTENT } = await importProvider();

    const result = await executeLauncher(CODEX_LAUNCHER_SCRIPT_CONTENT, wrapperArgs, {
      status: 200,
      args: [],
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(result.requestBody).toBeUndefined();
    expect(result.codexArgs).toBeNull();
  });
});
