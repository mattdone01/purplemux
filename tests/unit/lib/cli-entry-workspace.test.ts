import { execFile } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const entry = path.resolve('bin/purplemux.js');

describe('public CLI workspace routing', () => {
  it('routes workspace dirs show through the CLI rather than rejecting the command', async () => {
    const result = await run(process.execPath, [entry, 'workspace', 'dirs', 'show'], {
      env: { ...process.env, PMUX_PORT: '1', PMUX_TOKEN: 'test-token' },
    }).catch((error: { stderr: string }) => error);
    expect(result.stderr).not.toContain('unknown command: workspace');
    expect(result.stderr).toContain('-w');
  });
});
