import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isCodexSubagentHook,
  isSubagentSessionMeta,
  resetSubagentTranscriptCache,
  transcriptIsSubagent,
} from '@/lib/providers/codex/subagent-hook';

// Measured 2026-09-29 (tab-QizeO4): root 01a0eacc…, its native subagent 01a0eae0… (agent path
// /root/pass2_settle_ruling). The subagent's hooks re-keyed the root's tab.
const ROOT = '01a0eacc-66cd-7700-a4ae-72adbd13aa58';
const CHILD = '01a0eae0-a62b-79e1-b096-5c959155263e';

const rootMeta = { type: 'session_meta', payload: { id: ROOT, source: 'cli', originator: 'codex-tui' } };
const childMeta = {
  type: 'session_meta',
  payload: {
    id: CHILD,
    source: { subagent: { thread_spawn: { parent_thread_id: ROOT, depth: 1, agent_path: '/root/pass2_settle_ruling' } } },
    thread_source: 'subagent',
  },
};

describe('Codex subagent hooks', () => {
  let dir: string;
  const transcript = (session: string, meta: unknown | null) => {
    const file = path.join(dir, `rollout-2026-09-29T01-34-19-${session}.jsonl`);
    fs.writeFileSync(file, meta === null ? '' : `${JSON.stringify(meta)}\n{"type":"event_msg"}\n`);
    return file;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-codex-subagent-'));
    resetSubagentTranscriptCache();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reads a subagent's session_meta, and a root's", () => {
    expect(isSubagentSessionMeta(JSON.stringify(childMeta))).toBe(true);
    expect(isSubagentSessionMeta(JSON.stringify({ ...childMeta, payload: { id: CHILD, thread_source: 'subagent' } }))).toBe(true);
    expect(isSubagentSessionMeta(JSON.stringify(rootMeta))).toBe(false);
    expect(isSubagentSessionMeta('{"type":"event_msg"}')).toBe(false);
    expect(isSubagentSessionMeta('not json')).toBe(false);
  });

  it("the root's own hook is the root's", async () => {
    expect(await isCodexSubagentHook({ hook_event_name: 'Stop', session_id: ROOT, transcript_path: transcript(ROOT, rootMeta) })).toBe(false);
  });

  it('a hook whose transcript names another session than its session_id is a subagent (the case measured)', async () => {
    const childTranscript = transcript(CHILD, childMeta);

    expect(await isCodexSubagentHook({ hook_event_name: 'PostToolUse', session_id: ROOT, transcript_path: childTranscript })).toBe(true);
  });

  it('a subagent reporting its own id is still known by its session_meta', async () => {
    expect(await isCodexSubagentHook({ hook_event_name: 'PreToolUse', session_id: CHILD, transcript_path: transcript(CHILD, childMeta) })).toBe(true);
  });

  it('an unreadable or not-yet-written transcript is not a subagent, and is not cached', async () => {
    const missing = path.join(dir, `rollout-x-${ROOT}.jsonl`);
    expect(await transcriptIsSubagent(missing)).toBe(false);
    fs.writeFileSync(missing, `${JSON.stringify(childMeta)}\n`);
    expect(await transcriptIsSubagent(missing)).toBe(true);
    const empty = transcript(ROOT, null);
    expect(await transcriptIsSubagent(empty)).toBe(false);
  });

  it('a hook without a transcript is not a subagent', async () => {
    expect(await isCodexSubagentHook({ hook_event_name: 'SessionStart', session_id: ROOT })).toBe(false);
  });
});
