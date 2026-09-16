import { describe, expect, it } from 'vitest';
import { parse as parseToml } from 'smol-toml';
import { CODEX_LAUNCHER_SCRIPT_CONTENT } from '@/lib/providers/codex';
import { toTomlBasicString } from '@/lib/providers/codex/prompt';

describe('codex prompt config encoding', () => {
  it('encodes multiline developer instructions as a single command-line TOML value', () => {
    const content = [
      '# purplemux context',
      '',
      "It can include 'single quotes' and ''' triple quotes.",
      'Use `purplemux workspaces` when needed.',
    ].join('\n');

    const encoded = toTomlBasicString(content);

    expect(encoded).not.toContain('\n');
    expect(parseToml(`developer_instructions=${encoded}`)).toEqual({
      developer_instructions: content,
    });
  });

  it('uses a stable Node launcher that asks the server for runtime args', () => {
    expect(CODEX_LAUNCHER_SCRIPT_CONTENT).toContain('/api/cli/codex/launch-args');
    expect(CODEX_LAUNCHER_SCRIPT_CONTENT).toContain("spawn('codex', args");
  });
});
