import { generateKeyPairSync } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFcmMessage,
  createFcmChannel,
  createFcmChannelFromEnv,
  isReapableFcmError,
  payloadViolationFields,
  registerFcmChannel,
} from '@/lib/fcm-channel';
import { NotificationDispatcher, createStatusSocketChannel, createWebPushChannel } from '@/lib/notification-dispatcher';
import type { IFcmSubscriptionRecord } from '@/lib/push-subscriptions';
import { alertFor } from '@/lib/alert-policy';
import type { IAlert, TAlertKind } from '@/types/status';

const logSpy = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({ createLogger: () => logSpy }));

const AT = 1_700_000_000_000;

const BAD_REQUEST_DETAIL = {
  '@type': 'type.googleapis.com/google.rpc.BadRequest',
  fieldViolations: [{ field: 'message.android.priority', description: 'Invalid value at priority' }],
};

const FCM_ERROR_DETAIL = {
  '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
  errorCode: 'INVALID_ARGUMENT',
};

const alert = (kind: TAlertKind = 'needs-input'): IAlert => ({
  ...alertFor({
    kind,
    tabId: 'T1',
    workspaceId: 'ws-1',
    workspaceName: 'Epic',
    tabName: 'orchestrator',
    providerId: 'claude',
    isOrchestrator: true,
    at: AT,
    lastUserMessage: 'run the migration',
    headline: 'blocked on schema',
  }),
  id: 'alert-1',
  seq: 7,
});

const record = (token: string, deviceId?: string): IFcmSubscriptionRecord => ({
  kind: 'fcm',
  token,
  deviceId,
  createdAt: 0,
});

interface ISentRequest {
  url: string;
  authorization: string;
  body: Record<string, unknown>;
}

const errorResponse = (status: number, body: unknown) => ({ ok: false, status, json: async () => body });

const setup = (
  records: IFcmSubscriptionRecord[],
  options: { visible?: string[]; respond?: (token: string) => { ok: boolean; status: number; json: () => Promise<unknown> } } = {},
) => {
  const visible = options.visible ?? [];
  const sent: ISentRequest[] = [];
  const dropped: string[] = [];
  const accessToken = vi.fn(async () => 'ya29.access');
  const channel = createFcmChannel({
    projectId: 'pmux-alerts',
    listRecords: async () => records,
    accessToken,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body) as { message: { token: string } };
      sent.push({ url, authorization: init.headers.authorization, body });
      return options.respond?.(body.message.token) ?? { ok: true, status: 200, json: async () => ({ name: 'projects/x/messages/1' }) };
    },
    drop: async (token) => { dropped.push(token); },
    isDeviceVisible: (deviceId) => visible.includes(deviceId),
    isAnyDeviceVisible: () => visible.length > 0,
  });
  return { channel, sent, dropped, accessToken };
};

const writeServiceAccount = () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pmux-fcm-channel-'));
  const file = path.join(dir, 'service-account.json');
  fs.writeFileSync(file, JSON.stringify({
    type: 'service_account',
    project_id: 'pmux-alerts',
    client_email: 'alerts@pmux-alerts.iam.gserviceaccount.com',
    private_key: privateKey,
  }));
  return { dir, file };
};

beforeEach(() => {
  logSpy.info.mockClear();
  logSpy.warn.mockClear();
  logSpy.error.mockClear();
});

afterEach(() => {
  delete process.env.FCM_SERVICE_ACCOUNT_PATH;
});

describe('buildFcmMessage', () => {
  it('sends the whole notification:alert payload as string-valued data', () => {
    const message = buildFcmMessage(alert(), { agentSessionId: 'sess-1', workspaceDir: '/tmp/epic' }, 'device-token');

    expect(message).toEqual({
      message: {
        token: 'device-token',
        data: {
          id: 'alert-1',
          seq: '7',
          kind: 'needs-input',
          tabId: 'T1',
          workspaceId: 'ws-1',
          workspaceName: 'Epic',
          tabName: 'orchestrator',
          providerId: 'claude',
          isOrchestrator: 'true',
          title: 'Input Required',
          body: 'run the migration',
          at: String(AT),
          agentSessionId: 'sess-1',
          workspaceDir: '/tmp/epic',
        },
        android: { priority: 'high' },
      },
    });
  });

  it('never carries an FCM notification block, which would bypass the app renderer', () => {
    const message = buildFcmMessage(alert('review'), {}, 'device-token');
    const wire = JSON.parse(JSON.stringify(message)) as { message: Record<string, unknown> };

    expect(wire.message.notification).toBeUndefined();
    expect(JSON.stringify(message)).not.toContain('"notification"');
  });

  it('omits context fields the dispatch did not carry rather than sending the string "null"', () => {
    const message = buildFcmMessage(alert(), {}, 'device-token');

    expect(message.message.data).not.toHaveProperty('agentSessionId');
    expect(message.message.data).not.toHaveProperty('workspaceDir');
  });

  it('asks for high priority only when the alert needs input', () => {
    expect(buildFcmMessage(alert('needs-input'), {}, 't').message.android.priority).toBe('high');
    expect(buildFcmMessage(alert('review'), {}, 't').message.android.priority).toBe('normal');
    expect(buildFcmMessage(alert('work-stalled'), {}, 't').message.android.priority).toBe('normal');
  });
});

describe('createFcmChannel', () => {
  it('posts one data message per subscription to the project send endpoint', async () => {
    const { channel, sent } = setup([record('tok-a', 'D1'), record('tok-b', 'D2')]);

    await channel.deliver(alert(), {});

    expect(sent.map((s) => s.url)).toEqual([
      'https://fcm.googleapis.com/v1/projects/pmux-alerts/messages:send',
      'https://fcm.googleapis.com/v1/projects/pmux-alerts/messages:send',
    ]);
    expect(sent[0].authorization).toBe('Bearer ya29.access');
    expect(sent.map((s) => (s.body.message as { token: string }).token)).toEqual(['tok-a', 'tok-b']);
  });

  it('suppresses only the subscriptions bound to a visible device', async () => {
    const { channel, sent } = setup([record('tok-desktop', 'D1'), record('tok-phone', 'D2')], { visible: ['D1'] });

    await channel.deliver(alert(), {});

    expect(sent.map((s) => (s.body.message as { token: string }).token)).toEqual(['tok-phone']);
  });

  it('falls back to the global gate for a subscription with no device binding', async () => {
    const bound = setup([record('tok-legacy')], { visible: ['D1'] });
    await bound.channel.deliver(alert(), {});
    expect(bound.sent).toHaveLength(0);

    const quiet = setup([record('tok-legacy')]);
    await quiet.channel.deliver(alert(), {});
    expect(quiet.sent).toHaveLength(1);
  });

  it('mints no access token when nothing is subscribed or everything is visible', async () => {
    const none = setup([]);
    await none.channel.deliver(alert(), {});
    expect(none.accessToken).not.toHaveBeenCalled();

    const allVisible = setup([record('tok-a', 'D1')], { visible: ['D1'] });
    await allVisible.channel.deliver(alert(), {});
    expect(allVisible.accessToken).not.toHaveBeenCalled();
  });

  it('reaps a token FCM reports as UNREGISTERED', async () => {
    const { channel, dropped, sent } = setup([record('tok-gone', 'D1'), record('tok-live', 'D2')], {
      respond: (token) => token === 'tok-gone'
        ? errorResponse(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } })
        : { ok: true, status: 200, json: async () => ({}) },
    });

    await channel.deliver(alert(), {});

    expect(dropped).toEqual(['tok-gone']);
    expect(sent).toHaveLength(2);
  });

  it('reaps a token FCM rejects as INVALID_ARGUMENT', async () => {
    const { channel, dropped } = setup([record('tok-bad', 'D1')], {
      respond: () => errorResponse(400, { error: { status: 'INVALID_ARGUMENT', details: [FCM_ERROR_DETAIL] } }),
    });

    await channel.deliver(alert(), {});

    expect(dropped).toEqual(['tok-bad']);
  });

  it('reaps nothing when INVALID_ARGUMENT is FCM refusing our message shape', async () => {
    const { channel, dropped, sent } = setup([record('tok-a', 'D1'), record('tok-b', 'D2')], {
      respond: () => errorResponse(400, {
        error: { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload', details: [BAD_REQUEST_DETAIL] },
      }),
    });

    await channel.deliver(alert(), {});

    expect(dropped).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('logs a payload rejection as an error naming the offending field', async () => {
    const { channel } = setup([record('tok-a', 'D1')], {
      respond: () => errorResponse(400, { error: { status: 'INVALID_ARGUMENT', details: [BAD_REQUEST_DETAIL] } }),
    });

    await channel.deliver(alert(), {});

    expect(logSpy.error).toHaveBeenCalledTimes(1);
    const line = logSpy.error.mock.calls[0][0] as string;
    expect(line).toContain('message.android.priority');
    expect(line).toContain('no token reaped');
  });

  it('still reaps when a payload violation and a dead token arrive on different sends', async () => {
    const { channel, dropped } = setup([record('tok-shape', 'D1'), record('tok-gone', 'D2')], {
      respond: (token) => token === 'tok-shape'
        ? errorResponse(400, { error: { status: 'INVALID_ARGUMENT', details: [BAD_REQUEST_DETAIL] } })
        : errorResponse(404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }),
    });

    await channel.deliver(alert(), {});

    expect(dropped).toEqual(['tok-gone']);
  });

  it('keeps a token that failed for a transient or unrelated reason', async () => {
    const transient = setup([record('tok-flaky', 'D1')], {
      respond: () => errorResponse(503, { error: { status: 'UNAVAILABLE', details: [{ errorCode: 'UNAVAILABLE' }] } }),
    });
    await transient.channel.deliver(alert(), {});
    expect(transient.dropped).toEqual([]);

    const wrongProject = setup([record('tok-ok', 'D1')], {
      respond: () => errorResponse(404, { error: { status: 'NOT_FOUND', message: 'Requested entity was not found.' } }),
    });
    await wrongProject.channel.deliver(alert(), {});
    expect(wrongProject.dropped).toEqual([]);
  });

  it('keeps sending to the remaining tokens when one request throws', async () => {
    const { channel, sent } = setup([record('tok-a', 'D1'), record('tok-b', 'D2')], {
      respond: (token) => {
        if (token === 'tok-a') throw new Error('socket hang up');
        return { ok: true, status: 200, json: async () => ({}) };
      },
    });

    await channel.deliver(alert(), {});

    expect(sent.map((s) => (s.body.message as { token: string }).token)).toEqual(['tok-a', 'tok-b']);
  });
});

describe('payloadViolationFields', () => {
  it('separates a message-shape complaint from a token rejection', () => {
    const shape = { error: { status: 'INVALID_ARGUMENT', details: [BAD_REQUEST_DETAIL] } };
    const token = { error: { status: 'INVALID_ARGUMENT', details: [FCM_ERROR_DETAIL] } };

    expect(payloadViolationFields(shape)).toEqual(['message.android.priority']);
    expect(isReapableFcmError(shape)).toBe(false);

    expect(payloadViolationFields(token)).toBeNull();
    expect(isReapableFcmError(token)).toBe(true);
  });

  it('refuses to reap when a BadRequest detail rides alongside an FcmError one', () => {
    const mixed = { error: { status: 'INVALID_ARGUMENT', details: [FCM_ERROR_DETAIL, BAD_REQUEST_DETAIL] } };

    expect(isReapableFcmError(mixed)).toBe(false);
  });

  it('treats a BadRequest detail with no named field as a payload rejection', () => {
    const bare = { error: { status: 'INVALID_ARGUMENT', details: [{ fieldViolations: [] }] } };

    expect(payloadViolationFields(bare)).toEqual([]);
    expect(isReapableFcmError(bare)).toBe(false);
  });

  it('reports no violations for a body that carries none', () => {
    expect(payloadViolationFields(null)).toBeNull();
    expect(payloadViolationFields({})).toBeNull();
    expect(payloadViolationFields({ error: { status: 'UNAVAILABLE' } })).toBeNull();
  });
});

describe('registerFcmChannel', () => {
  it('registers nothing when FCM_SERVICE_ACCOUNT_PATH is unset, leaving the other channels alone', () => {
    const dispatcher = new NotificationDispatcher();
    dispatcher.register(createStatusSocketChannel(() => {}));
    dispatcher.register(createWebPushChannel());

    expect(registerFcmChannel(dispatcher)).toBe(false);
    expect(dispatcher.channelNames()).toEqual(['status-socket', 'web-push']);
    expect(dispatcher.has('fcm')).toBe(false);
  });

  it('registers nothing when the configured key file is unreadable', () => {
    process.env.FCM_SERVICE_ACCOUNT_PATH = path.join(os.tmpdir(), 'pmux-fcm-does-not-exist.json');
    const dispatcher = new NotificationDispatcher();

    expect(registerFcmChannel(dispatcher)).toBe(false);
    expect(dispatcher.channelNames()).toEqual([]);
  });

  it('registers the fcm channel beside the others once a key file is configured', () => {
    const { file } = writeServiceAccount();
    process.env.FCM_SERVICE_ACCOUNT_PATH = file;
    const dispatcher = new NotificationDispatcher();
    dispatcher.register(createStatusSocketChannel(() => {}));

    expect(registerFcmChannel(dispatcher)).toBe(true);
    expect(dispatcher.channelNames()).toEqual(['status-socket', 'fcm']);
  });

  it('builds a channel named fcm from the env-configured key file', () => {
    const { file } = writeServiceAccount();
    process.env.FCM_SERVICE_ACCOUNT_PATH = file;

    expect(createFcmChannelFromEnv()?.name).toBe('fcm');
  });

  it('returns null with no key file configured', () => {
    expect(createFcmChannelFromEnv()).toBeNull();
  });
});
