import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POOL_PATH_SLOW_MS,
  ageTailnetPath,
  isIpLiteral,
  isTailnetIp,
  measureTailnetPath,
  parseGoDurationMs,
  parseSshHostname,
  parseTailscalePing,
  pathAlert,
  pathAlertText,
  pathView,
  type ITailnetPathDeps,
} from '@/lib/tailnet-path';
import type { IPoolPathRead } from '@/types/pool';

const T0 = 1_800_000_000_000;

/** Measured from agent-exec-v2 on 2026-11-09 05:13Z; the command exited 1. */
const DERP_PONG = 'pong from mdserver1 (100.94.44.114) via DERP(syd) in 147ms\ndirect connection not established\n';
const DERP_SIN = 'pong from mdserver1 (100.94.44.114) via DERP(sin) in 1.17s\ndirect connection not established\n';
const DIRECT_PONG = 'pong from ai-server (100.101.2.3) via 192.168.1.155:41641 in 3ms\n';
const PEER_RELAY_PONG = 'pong from exec-2 (100.70.1.9) via peer-relay(10.0.0.5:7777:vni:12) in 41ms\n';

const deps = (over: Partial<ITailnetPathDeps> = {}): ITailnetPathDeps => ({
  now: () => T0,
  sshConfig: async (alias) => `user agent\nhostname ${alias}.taila9cda5.ts.net\nport 22\n`,
  resolve: async () => ['100.94.44.114'],
  ping: async () => DERP_PONG,
  ...over,
});

const read = (over: Partial<IPoolPathRead> = {}): IPoolPathRead => ({
  kind: 'direct', alias: 'exec-1', address: 'exec-1', ip: '100.64.0.9', peer: 'exec-1', region: null, rttMs: 4, measuredAt: T0, reason: null, ...over,
});

describe('parseSshHostname', () => {
  it('reads the hostname line of ssh -G, whatever its case', () => {
    expect(parseSshHostname('user agent\nhostname 192.168.1.155\nport 22\n')).toBe('192.168.1.155');
    expect(parseSshHostname('HostName exec-1.taila9cda5.ts.net\n')).toBe('exec-1.taila9cda5.ts.net');
  });

  it('answers null with no hostname line', () => {
    expect(parseSshHostname('user agent\nport 22\n')).toBeNull();
  });
});

describe('isTailnetIp and isIpLiteral', () => {
  it.each([
    ['100.64.0.1', true], ['100.127.255.254', true], ['100.94.44.114', true],
    ['100.63.255.255', false], ['100.128.0.1', false], ['192.168.1.155', false], ['10.0.0.1', false],
    ['fd7a:115c:a1e0::c737:2c73', true], ['fd7a:115c:a1e1::1', false], ['::1', false], ['ai-lan', false],
  ])('%s → %s', (ip, expected) => {
    expect(isTailnetIp(ip)).toBe(expected);
  });

  it('tells an IP literal from a name', () => {
    expect(isIpLiteral('192.168.1.155')).toBe(true);
    expect(isIpLiteral('fd7a:115c:a1e0::1')).toBe(true);
    expect(isIpLiteral('999.1.1.1')).toBe(false);
    expect(isIpLiteral('ai-lan')).toBe(false);
    expect(isIpLiteral('deadbeef')).toBe(false);
  });
});

describe('parseGoDurationMs', () => {
  it.each([
    ['147ms', 147], ['1.17s', 1170], ['850µs', 0.85], ['850us', 0.85], ['1m2.5s', 62_500], ['3ms', 3],
  ])('%s → %s ms', (text, ms) => {
    expect(parseGoDurationMs(text)).toBe(ms);
  });

  it.each(['', 'fast', '12', '3msx', '-1ms'])('refuses %j', (text) => {
    expect(parseGoDurationMs(text)).toBeNull();
  });
});

describe('parseTailscalePing', () => {
  it('reads a DERP pong even though the command then says no direct connection (the retro case)', () => {
    expect(parseTailscalePing(DERP_PONG)).toEqual({ ok: true, peer: 'mdserver1', transport: 'relayed', region: 'syd', rttMs: 147 });
    expect(parseTailscalePing(DERP_SIN)).toEqual({ ok: true, peer: 'mdserver1', transport: 'relayed', region: 'sin', rttMs: 1170 });
  });

  it('reads a direct pong', () => {
    expect(parseTailscalePing(DIRECT_PONG)).toEqual({ ok: true, peer: 'ai-server', transport: 'direct', region: null, rttMs: 3 });
  });

  it('reads a peer relay as relayed', () => {
    expect(parseTailscalePing(PEER_RELAY_PONG)).toMatchObject({ ok: true, transport: 'relayed', region: 'peer-relay', rttMs: 41 });
  });

  it('answers the last line when no pong came', () => {
    expect(parseTailscalePing('timeout waiting for ping reply\n')).toEqual({ ok: false, reason: 'timeout waiting for ping reply' });
    expect(parseTailscalePing('')).toEqual({ ok: false, reason: 'no answer' });
  });

  it('never reads a pong line with an unreadable duration as a measurement', () => {
    expect(parseTailscalePing('pong from x (100.64.0.1) via DERP(sin) in soon\n')).toEqual({
      ok: false, reason: 'pong from x (100.64.0.1) via DERP(sin) in soon',
    });
  });
});

describe('measureTailnetPath', () => {
  it('measures a relayed host: the alias resolves into the tailnet and the pong came through DERP', async () => {
    const pinged: string[] = [];
    const path = await measureTailnetPath(deps({ ping: async (ip) => { pinged.push(ip); return DERP_SIN; } }), 'exec-1');

    expect(path).toEqual({
      kind: 'relayed', alias: 'exec-1', address: 'exec-1.taila9cda5.ts.net', ip: '100.94.44.114', peer: 'mdserver1',
      region: 'sin', rttMs: 1170, measuredAt: T0, reason: null,
    });
    expect(pinged).toEqual(['100.94.44.114']);
  });

  it('measures a direct host', async () => {
    const path = await measureTailnetPath(deps({ ping: async () => DIRECT_PONG }), 'ai-server');

    expect(path).toMatchObject({ kind: 'direct', rttMs: 3, region: null });
  });

  it('calls a LAN alias not-tailnet and pings nothing', async () => {
    let pinged = false;
    const path = await measureTailnetPath(deps({
      sshConfig: async () => 'hostname 192.168.1.155\n',
      ping: async () => { pinged = true; return DIRECT_PONG; },
    }), 'ai-lan');

    expect(path).toMatchObject({ kind: 'not-tailnet', address: '192.168.1.155', ip: '192.168.1.155', reason: null });
    expect(pinged).toBe(false);
  });

  it('takes the tailnet address of a name that resolves to several', async () => {
    const path = await measureTailnetPath(deps({ resolve: async () => ['192.168.1.6', '100.94.44.114'] }), 'mdserver1');

    expect(path).toMatchObject({ kind: 'relayed', ip: '100.94.44.114' });
  });

  it('reads every failure as unknown with its reason, never as direct', async () => {
    const sshFails = await measureTailnetPath(deps({ sshConfig: async () => { throw new Error('ssh: bad option'); } }), 'x');
    const noHost = await measureTailnetPath(deps({ sshConfig: async () => 'port 22\n' }), 'x');
    const noResolve = await measureTailnetPath(deps({ resolve: async () => { throw new Error('ENOTFOUND x'); } }), 'x');
    const noPong = await measureTailnetPath(deps({ ping: async () => 'timeout waiting for ping reply\n' }), 'x');
    const noTailscale = await measureTailnetPath(deps({ ping: async () => { throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' }); } }), 'x');

    expect(sshFails).toMatchObject({ kind: 'unknown', reason: 'ssh -G failed: ssh: bad option' });
    expect(noHost).toMatchObject({ kind: 'unknown', reason: 'ssh -G printed no hostname' });
    expect(noResolve).toMatchObject({ kind: 'unknown', reason: 'x.taila9cda5.ts.net does not resolve: ENOTFOUND x' });
    expect(noPong).toMatchObject({ kind: 'unknown', reason: 'tailscale ping 100.94.44.114: timeout waiting for ping reply' });
    expect(noTailscale).toMatchObject({ kind: 'unknown', reason: 'tailscale ping 100.94.44.114: tailscale is not installed on this host' });
  });
});

describe('pathAlert', () => {
  it('raises relayed for any relayed path, even a fast one: relayed wins over slow', () => {
    expect(pathAlert(read({ kind: 'relayed', rttMs: 20 }), 250)).toBe('tailnet-relayed');
    expect(pathAlert(read({ kind: 'relayed', rttMs: 1170 }), 250)).toBe('tailnet-relayed');
  });

  it('raises slow for a direct path at or above the threshold', () => {
    expect(pathAlert(read({ rttMs: 249 }), 250)).toBeNull();
    expect(pathAlert(read({ rttMs: 250 }), 250)).toBe('tailnet-slow');
  });

  it('raises nothing for a path that is not measured or not on the tailnet', () => {
    expect(pathAlert(read({ kind: 'unknown', rttMs: null }), 250)).toBeNull();
    expect(pathAlert(read({ kind: 'not-tailnet', rttMs: null }), 250)).toBeNull();
  });
});

describe('ageTailnetPath, pathView and pathAlertText', () => {
  it('turns a measurement older than the staleness into unknown, with its age', () => {
    expect(ageTailnetPath(read(), T0 + 90_000, 90_000)).toEqual(read());
    expect(ageTailnetPath(read({ kind: 'relayed' }), T0 + 91_000, 90_000)).toMatchObject({ kind: 'unknown', reason: 'last measured 91 s ago' });
  });

  it('serves the alert, the threshold and the time', () => {
    expect(pathView(read({ kind: 'relayed', region: 'sin', rttMs: 1170 }), DEFAULT_POOL_PATH_SLOW_MS)).toEqual({
      kind: 'relayed', alert: 'tailnet-relayed', alias: 'exec-1', address: 'exec-1', ip: '100.64.0.9', peer: 'exec-1',
      region: 'sin', rttMs: 1170, slowMs: 250, measuredAt: new Date(T0).toISOString(), reason: null,
    });
  });

  it('writes one line per alert', () => {
    expect(pathAlertText('exec-1', pathView(read({ kind: 'relayed', region: 'sin', rttMs: 1170.4 }), 250)))
      .toBe('exec-1 tailnet path relayed via DERP(sin), RTT 1170 ms');
    expect(pathAlertText('exec-2', pathView(read({ kind: 'relayed', region: 'peer-relay', rttMs: 41 }), 250)))
      .toBe('exec-2 tailnet path relayed via a peer relay, RTT 41 ms');
    expect(pathAlertText('exec-3', pathView(read({ rttMs: 300 }), 250))).toBe('exec-3 tailnet path slow: RTT 300 ms (threshold 250 ms)');
  });
});
