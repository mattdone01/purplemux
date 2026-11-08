import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { parseWorkerEvent } from '@/lib/worker-event-schema';
import {
  DEFAULT_PATCH_ID_COMMAND,
  EVIDENCE_TEXT_MAX_BYTES,
  GATE_LOG_MAX_BYTES,
  fsEvidenceReader,
  lastGateTree,
  patchIdCommandFrom,
  resolveEvidence,
  validateWorkerEvent,
  type IEventValidator,
  type IValidationContext,
} from '@/lib/worker-event-validators';
import { BASE, FakeEvidence, HEAD, KEY, REPO, TREE, range, reviewReadyPayload } from './worker-event-fakes';

// ADR-0043 §3: each evidence check against a fake file system and git; then the real reader once.

let f: FakeEvidence;
let ctx: IValidationContext;

const reviewReady = (change: Record<string, unknown> = {}) => parseWorkerEvent('review-ready', { ...reviewReadyPayload, ...change });
const checksOf = async (event = reviewReady()) => validateWorkerEvent(event, ctx);

beforeEach(() => {
  f = new FakeEvidence();
  ctx = { reader: f.reader(), roots: ['/w'], patchIdCommand: patchIdCommandFrom(undefined) };
});

describe('a complete evidence set', () => {
  it('passes every check of review-ready, landed and blocked-on', async () => {
    await expect(checksOf()).resolves.toEqual({
      passed: ['evidence-paths', 'range', 'gate-tree', 'patch-id', 'review-folder', 'receipt'], failures: [],
    });
    expect(f.runs).toEqual([{ argv: ['tools/patch-id.sh', BASE, HEAD], cwd: REPO }]);
    await expect(validateWorkerEvent(parseWorkerEvent('landed', { ...range, key: KEY }), ctx))
      .resolves.toEqual({ passed: ['evidence-paths', 'range'], failures: [] });
    await expect(validateWorkerEvent(parseWorkerEvent('blocked-on', { ...range, reason: 'r', clearInput: 'c' }), ctx))
      .resolves.toEqual({ passed: ['evidence-paths', 'range'], failures: [] });
  });
});

describe('evidence-paths (confinement before any read)', () => {
  it('refuses a path that resolves outside the roots, and reads nothing at it', async () => {
    f.files.set('/home/u/.purplemux/notes.json', '{}');
    f.links.set('/w/gate.log', '/home/u/.purplemux/notes.json');
    const result = await checksOf();
    expect(result.passed).toEqual([]);
    expect(result.failures).toEqual([{
      check: 'evidence-paths', measured: 'gateLog=/w/gate.log resolves to /home/u/.purplemux/notes.json', expected: 'a path under /w',
    }]);
    expect(f.runs).toEqual([]);
  });

  it('refuses a root prefix that is not a parent (/w2 is not under /w)', async () => {
    f.dirs.add('/w2');
    f.dirs.add('/w2/repo');
    const result = await validateWorkerEvent(parseWorkerEvent('landed', { ...range, key: KEY, repo: '/w2/repo' }), ctx);
    expect(result.failures[0]).toMatchObject({ check: 'evidence-paths', measured: 'repo=/w2/repo resolves to /w2/repo' });
  });

  it('refuses a missing path, a FIFO-like entry and a file where a directory belongs', async () => {
    f.files.delete(`/w/receipts/${KEY}.md`);
    f.files.delete('/w/gate.log');
    f.others.add('/w/gate.log');
    f.dirs.delete('/w/review/x-r1');
    f.files.set('/w/review/x-r1', 'not a dir');
    const { failures } = await checksOf();
    expect(failures.map((x) => x.measured)).toEqual([
      'gateLog=/w/gate.log is not a regular file or directory',
      'reviewDir=/w/review/x-r1 is a regular file',
      `receipt=/w/receipts/${KEY}.md does not exist`,
    ]);
  });

  it('refuses every event when the workspace has no directories', async () => {
    const { failures } = await validateWorkerEvent(reviewReady(), { ...ctx, roots: [] });
    expect(failures).toEqual([{ check: 'evidence-paths', measured: 'the sender workspace has no directories', expected: expect.any(String) }]);
  });

  it('hands the validators the resolved real paths', async () => {
    f.links.set('/w/link-to-log', '/w/gate.log');
    const resolved = await resolveEvidence(reviewReady({ gateLog: '/w/link-to-log' }), ctx);
    expect(resolved.evidence).toMatchObject({ repo: REPO, gateLog: '/w/gate.log' });
  });
});

describe('range: head is the branch tip, base its ancestor', () => {
  it('refuses a stale head (the branch moved on)', async () => {
    f.refs.set('refs/heads/story/x-1', 'e'.repeat(40));
    const { failures } = await checksOf();
    expect(failures).toContainEqual({ check: 'range', measured: `refs/heads/story/x-1=${'e'.repeat(40)}`, expected: `head ${HEAD} (the branch's current tip)` });
  });

  it('refuses an absent branch, a base that is no commit, and a base off the branch', async () => {
    f.refs.clear();
    expect((await checksOf()).failures).toContainEqual(expect.objectContaining({ check: 'range', measured: 'refs/heads/story/x-1=<absent>' }));
    f = new FakeEvidence();
    ctx = { ...ctx, reader: f.reader() };
    f.commits.delete(BASE);
    expect((await checksOf()).failures).toContainEqual(expect.objectContaining({ check: 'range', measured: `base ${BASE} is not a commit in ${REPO}` }));
    f = new FakeEvidence();
    ctx = { ...ctx, reader: f.reader() };
    f.ancestors.clear();
    expect((await checksOf()).failures).toContainEqual({ check: 'range', measured: `base ${BASE} is not an ancestor of head ${HEAD}`, expected: 'base..head is a range of the branch' });
  });
});

describe('gate-tree: the last run of the gate log gated the tree of head', () => {
  it('refuses another tree, naming both', async () => {
    f.files.set('/w/gate.log', `START=1\nGIT_TREE_END=${'9'.repeat(40)}\n`);
    expect((await checksOf()).failures).toEqual([{
      check: 'gate-tree', measured: `GIT_TREE_END=${'9'.repeat(40)}`, expected: `GIT_TREE_END=${TREE} (the tree of head ${HEAD})`,
    }]);
  });

  it('refuses a log whose last run has no GIT_TREE_END, although an earlier run had the right one', async () => {
    f.files.set('/w/gate.log', `START=1\nGIT_TREE_END=${TREE}\nVERDICT=VALID\nSTART=2\nrunning\n`);
    expect((await checksOf()).failures).toEqual([expect.objectContaining({ check: 'gate-tree', measured: 'the last run of the gate log has no GIT_TREE_END= line' })]);
  });

  it('refuses a head with no tree and an over-size log', async () => {
    f.trees.clear();
    expect((await checksOf()).failures).toContainEqual(expect.objectContaining({ check: 'gate-tree', measured: `head ${HEAD} has no tree in ${REPO}` }));
    f = new FakeEvidence();
    ctx = { ...ctx, reader: f.reader() };
    f.files.set('/w/gate.log', 'x'.repeat(16));
    const small: IValidationContext = { ...ctx, reader: { ...ctx.reader, readText: async (p, max) => (p === '/w/gate.log' ? { tooLarge: max + 1 } : ctx.reader.readText(p, max)) } };
    expect((await validateWorkerEvent(reviewReady(), small)).failures).toContainEqual(expect.objectContaining({
      check: 'gate-tree', measured: `gate log is ${GATE_LOG_MAX_BYTES + 1} bytes`,
    }));
  });

  it('reads the last run as gate-commit-check.sh does', () => {
    expect(lastGateTree('GIT_TREE_END=t1\nGIT_TREE_END=t2\n')).toBe('t2');
    expect(lastGateTree('START=1\nGIT_TREE_END=t1\nSTART=2\nGIT_TREE_END=t3\n')).toBe('t3');
    expect(lastGateTree('START=1\nGIT_TREE_END=t1\nSTART=2\n')).toBeNull();
    expect(lastGateTree('GIT_TREE_END= t4 \r\n')).toBe('t4');
    expect(lastGateTree(' GIT_TREE_END=t5\n')).toBeNull();
  });
});

describe('patch-id: the key recomputes from base..head', () => {
  it('refuses another key, naming the command and what it printed', async () => {
    f.command = () => ({ code: 0, stdout: `noise\n${'f'.repeat(40)}\n\n`, stderr: '' });
    expect((await checksOf()).failures).toEqual([{
      check: 'patch-id', measured: `tools/patch-id.sh ${BASE} ${HEAD} printed ${'f'.repeat(40)}`, expected: `key ${KEY}`,
    }]);
  });

  it('refuses a failed command with its first words of stderr, control characters removed', async () => {
    f.command = () => ({ code: 1, stdout: KEY, stderr: 'FAIL: patch-id: no diff\u001b[31m\n' });
    expect((await checksOf()).failures).toEqual([expect.objectContaining({
      check: 'patch-id', measured: `tools/patch-id.sh ${BASE} ${HEAD} exited 1: FAIL: patch-id: no diff [31m`,
    })]);
    f.command = () => ({ code: null, stdout: '', stderr: 'spawn tools/patch-id.sh ENOENT' });
    expect((await checksOf()).failures[0].measured).toContain('exited abnormally: spawn tools/patch-id.sh ENOENT');
  });

  it('runs the configured command with base and head in place', () => {
    expect(patchIdCommandFrom(undefined)('B', 'H')).toEqual(['tools/patch-id.sh', 'B', 'H']);
    expect(DEFAULT_PATCH_ID_COMMAND).toEqual(['tools/patch-id.sh', '{base}', '{head}']);
    expect(patchIdCommandFrom('["scripts/key", "--range", "{base}..{head}"]')('B', 'H')).toEqual(['scripts/key', '--range', 'B..H']);
    expect(patchIdCommandFrom('not json')('B', 'H')).toEqual(['tools/patch-id.sh', 'B', 'H']);
    expect(patchIdCommandFrom('[]')('B', 'H')).toEqual(['tools/patch-id.sh', 'B', 'H']);
    expect(patchIdCommandFrom('["ok", 3]')('B', 'H')).toEqual(['tools/patch-id.sh', 'B', 'H']);
  });
});

describe('review-folder: the five files, reviewing this key', () => {
  it('names every missing file', async () => {
    f.files.delete('/w/review/x-r1/status.txt');
    f.files.delete('/w/review/x-r1/record.md');
    f.dirs.add('/w/review/x-r1/diff.patch');
    f.files.delete('/w/review/x-r1/diff.patch');
    expect((await checksOf()).failures).toEqual([{
      check: 'review-folder', measured: '/w/review/x-r1 lacks diff.patch, status.txt, record.md',
      expected: '/w/review/x-r1 holds range.txt, diff.patch, status.txt, patch-id.txt, record.md',
    }]);
  });

  it('refuses a folder that reviews another key', async () => {
    f.files.set('/w/review/x-r1/patch-id.txt', `${'0'.repeat(40)}\n`);
    expect((await checksOf()).failures).toEqual([expect.objectContaining({ check: 'review-folder', measured: `patch-id.txt names ${'0'.repeat(40)}` })]);
  });

  it('refuses a patch-id.txt that links outside the roots, and an over-size one', async () => {
    f.files.set('/etc/key', KEY);
    f.links.set('/w/review/x-r1/patch-id.txt', '/etc/key');
    expect((await checksOf()).failures).toEqual([expect.objectContaining({ check: 'review-folder', measured: '/w/review/x-r1/patch-id.txt resolves outside the evidence roots' })]);
    f = new FakeEvidence();
    f.files.set('/w/review/x-r1/patch-id.txt', 'k'.repeat(EVIDENCE_TEXT_MAX_BYTES + 1));
    ctx = { ...ctx, reader: f.reader() };
    expect((await checksOf()).failures).toEqual([expect.objectContaining({ check: 'review-folder', measured: `patch-id.txt is ${EVIDENCE_TEXT_MAX_BYTES + 1} bytes` })]);
  });
});

describe('receipt: <key>.md, never a BLOCK', () => {
  it('refuses a receipt under another name', async () => {
    f.files.set('/w/receipts/lane.md', 'verdict: PASS\n');
    expect((await checksOf(reviewReady({ receipt: '/w/receipts/lane.md' }))).failures).toEqual([{
      check: 'receipt', measured: 'receipt named lane.md', expected: `receipt named ${KEY}.md`,
    }]);
  });

  it('refuses a BLOCK receipt named as a block, saying why', async () => {
    f.files.set(`/w/receipts/${KEY}.block.md`, 'verdict: BLOCK\n');
    expect((await checksOf(reviewReady({ receipt: `/w/receipts/${KEY}.block.md` }))).failures[0].measured)
      .toBe(`receipt named ${KEY}.block.md (a BLOCK receipt is not review-ready)`);
  });

  it.each(['verdict: BLOCK\n', '# r\n  Verdict:   block — gate missing\n', 'round: 2\nverdict:BLOCK'])('refuses <key>.md holding %j', async (text) => {
    f.files.set(`/w/receipts/${KEY}.md`, text);
    expect((await checksOf()).failures).toEqual([{
      check: 'receipt', measured: `${KEY}.md holds verdict: BLOCK`, expected: `no BLOCK verdict in ${KEY}.md; a BLOCK belongs at ${KEY}.block.md`,
    }]);
  });

  it.each(['verdict: PASS\n', 'verdict: PASS-WITH-NITS\nnot BLOCK here: verdict: BLOCK\n', 'verdict: BLOCKED-ON-NOTHING\n'])('passes <key>.md holding %j', async (text) => {
    f.files.set(`/w/receipts/${KEY}.md`, text);
    expect((await checksOf()).failures).toEqual([]);
  });
});

describe('running the validators', () => {
  it('runs every check and lists every failure in one refusal', async () => {
    f.refs.set('refs/heads/story/x-1', 'e'.repeat(40));
    f.files.set('/w/gate.log', 'GIT_TREE_END=0\n');
    f.files.set(`/w/receipts/${KEY}.md`, 'verdict: BLOCK');
    const { passed, failures } = await checksOf();
    expect(passed).toEqual(['evidence-paths', 'patch-id', 'review-folder']);
    expect(failures.map((x) => x.check)).toEqual(['range', 'gate-tree', 'receipt']);
  });

  it('counts a validator that throws as a failure of that check, never a pass', async () => {
    const throwing: IEventValidator = { id: 'boom', types: ['landed'], check: async () => { throw new Error('disk\ngone'); } };
    const result = await validateWorkerEvent(parseWorkerEvent('landed', { ...range, key: KEY }), ctx, [throwing]);
    expect(result).toEqual({ passed: ['evidence-paths'], failures: [{ check: 'boom', measured: 'the check could not run: disk gone', expected: 'a check that runs' }] });
  });

  it('runs only the validators of the event type (a plugged-in validator is honoured)', async () => {
    const extra: IEventValidator = { id: 'extra', types: ['blocked-on'], check: async () => [{ check: 'extra', measured: 'm', expected: 'e' }] };
    await expect(validateWorkerEvent(parseWorkerEvent('landed', { ...range, key: KEY }), ctx, [extra])).resolves.toEqual({ passed: ['evidence-paths'], failures: [] });
  });
});

describe('the server reader against a real git repository', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-evidence-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'one');
  const base = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  git('commit', '-q', '-am', 'two');
  const head = git('rev-parse', 'HEAD');
  const tree = git('rev-parse', 'HEAD^{tree}');
  fs.mkdirSync(path.join(dir, 'tools'));
  fs.writeFileSync(path.join(dir, 'tools', 'patch-id.sh'), '#!/bin/sh\necho "key-for-$1-$2"\necho "token:${PMUX_TOKEN:-none}" >&2\nexit 3\n', { mode: 0o755 });

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('resolves refs, trees and ancestry with git', async () => {
    const real = fs.realpathSync(dir);
    await expect(fsEvidenceReader.revParse(real, 'refs/heads/main')).resolves.toBe(head);
    await expect(fsEvidenceReader.revParse(real, `${head}^{tree}`)).resolves.toBe(tree);
    await expect(fsEvidenceReader.revParse(real, 'refs/heads/absent')).resolves.toBeNull();
    await expect(fsEvidenceReader.isAncestor(real, base, head)).resolves.toBe(true);
    await expect(fsEvidenceReader.isAncestor(real, head, base)).resolves.toBe(false);
  });

  it('runs the command without a shell or the server token, in the repo', async () => {
    process.env.PMUX_TOKEN = 'secret-token';
    try {
      const result = await fsEvidenceReader.run(['tools/patch-id.sh', 'B', 'H'], fs.realpathSync(dir));
      expect(result).toEqual({ code: 3, stdout: 'key-for-B-H\n', stderr: 'token:none\n' });
    } finally {
      delete process.env.PMUX_TOKEN;
    }
    await expect(fsEvidenceReader.run(['tools/absent.sh'], dir)).resolves.toMatchObject({ code: null });
    await expect(fsEvidenceReader.run([], dir)).resolves.toEqual({ code: null, stdout: '', stderr: 'empty command' });
  });

  it('reads a regular file under a cap, and says what kind an entry is', async () => {
    const file = path.join(dir, 'a.txt');
    await expect(fsEvidenceReader.readText(file, 100)).resolves.toEqual({ text: 'two\n' });
    await expect(fsEvidenceReader.readText(file, 2)).resolves.toEqual({ tooLarge: 4 });
    await expect(fsEvidenceReader.kind(file)).resolves.toBe('file');
    await expect(fsEvidenceReader.kind(dir)).resolves.toBe('dir');
    await expect(fsEvidenceReader.kind('/dev/null')).resolves.toBe('other');
    await expect(fsEvidenceReader.kind(path.join(dir, 'absent'))).resolves.toBeNull();
    await expect(fsEvidenceReader.realpath(path.join(dir, 'absent'))).resolves.toBeNull();
    await expect(fsEvidenceReader.readText(dir, 100)).rejects.toThrow();
  });
});
