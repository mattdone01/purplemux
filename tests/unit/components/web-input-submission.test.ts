import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8');
describe('desktop and mobile app submission wiring', () => {
  it('uses authenticated submit for prompts and attachment-only Enter, with no raw send timer', () => {
    const hook = read('src/hooks/use-web-input.ts');
    const send = hook.slice(hook.indexOf('const send ='), hook.indexOf('const interrupt ='));
    expect(send).toContain('await sendWebPrompt'); expect(send).not.toContain('sendStdin'); expect(send).not.toContain('setTimeout');
    const bar = read('src/components/features/workspace/web-input-bar.tsx');
    const dispatch = bar.slice(bar.indexOf('const dispatch ='), bar.indexOf('const handleKeyDown ='));
    expect(dispatch).toContain('await send();');
    expect(dispatch).toContain('submit: false, literalPaste: true');
    expect(dispatch).toContain("hasText ? ` ${text}` : ''");
    expect(dispatch).not.toContain('sendStdin');
  });
  it.each(['claude-code', 'codex', 'grok'])('mobile %s uses the same guarded WebInputBar target', (provider) => {
    const source = read(`src/components/features/mobile/mobile-${provider}-panel.tsx`);
    expect(source).toContain('<WebInputBar'); expect(source).toContain('wsId={wsId}'); expect(source).toContain('sessionName={sessionName}');
  });
  it('raw persistence refusal is rendered visibly by the terminal client', () => {
    const client = read('src/hooks/use-terminal-websocket.ts');
    expect(client).toContain('case MSG_INPUT_ERROR:'); expect(client).toContain('toast.error(new TextDecoder().decode(payload))');
  });
});
