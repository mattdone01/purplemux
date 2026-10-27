import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { INotificationAlertMessage } from '@/types/status';

const warning = vi.hoisted(() => vi.fn());
const push = vi.hoisted(() => vi.fn(async () => true));

vi.mock('sonner', () => ({ toast: { warning } }));
vi.mock('next/router', () => ({ default: { push } }));

import { showNotificationAlert } from '@/hooks/use-agent-status';

describe('status socket alerts', () => {
  beforeEach(() => {
    warning.mockReset();
    push.mockClear();
  });

  it('ignores completion alerts owned by the configured subscriber and presents only missing coverage', () => {
    const completion: INotificationAlertMessage = {
      type: 'notification:alert',
      alert: {
        id: 'alert-complete',
        seq: 1,
        kind: 'review',
        tabId: 'worker',
        workspaceId: 'ws-1',
        workspaceName: 'Payments',
        tabName: 'worker',
        providerId: 'codex',
        isOrchestrator: false,
        title: 'Task Complete',
        body: 'Review the result',
        at: 41,
      },
    };
    const missing: INotificationAlertMessage = {
      type: 'notification:alert',
      alert: {
        id: 'alert-1',
        seq: 1,
        kind: 'orchestrator-missing',
        tabId: '',
        workspaceId: 'ws-1',
        workspaceName: 'Payments',
        tabName: '',
        providerId: 'claude',
        isOrchestrator: false,
        title: 'Orchestrator Missing',
        body: 'Work remains but no orchestrator is designated.',
        at: 42,
      },
    };

    showNotificationAlert(completion);
    showNotificationAlert(missing);

    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith('Orchestrator Missing', {
      id: 'alert-1',
      description: 'Work remains but no orchestrator is designated.',
    });
  });

  it('shows a flag alert for any tab role, with the flag text and a link to Mission Control (ADR-0032)', () => {
    const flag: INotificationAlertMessage = {
      type: 'notification:alert',
      alert: {
        id: 'alert-flag',
        seq: 3,
        kind: 'flag',
        tabId: 'worker',
        workspaceId: 'ws-1',
        workspaceName: 'Payments',
        tabName: 'worker',
        providerId: 'claude',
        isOrchestrator: false,
        title: 'Flag Raised',
        body: 'worker: busy with no activity for 37 min',
        at: 43,
        flag: { source: 'fleet', rule: 'stall', subject: 'worker', text: 'busy with no activity for 37 min' },
      },
    };

    showNotificationAlert(flag);

    expect(warning).toHaveBeenCalledTimes(1);
    const [title, options] = warning.mock.calls[0] as [string, { id: string; description: string; action: { label: string; onClick: () => void } }];
    expect(title).toBe('Flag Raised · Payments');
    expect(options.id).toBe('alert-flag');
    expect(options.description).toBe('worker: busy with no activity for 37 min');
    expect(options.action.label).toBe('Mission Control');
    options.action.onClick();
    expect(push).toHaveBeenCalledWith('/mission-control');
  });

  it('titles a flag toast without a workspace name by its title alone, and ignores a kind it does not know', () => {
    const base = {
      id: 'a', seq: 1, tabId: 't', workspaceId: 'ws-1', workspaceName: '', tabName: 't', providerId: 'claude' as const,
      isOrchestrator: true, title: 'Flag Raised', body: 'landing holds 12 items (threshold 10)', at: 1,
    };
    showNotificationAlert({ type: 'notification:alert', alert: { ...base, kind: 'flag' } });
    expect(warning).toHaveBeenCalledWith('Flag Raised', expect.objectContaining({ description: 'landing holds 12 items (threshold 10)' }));
    warning.mockReset();
    showNotificationAlert({ type: 'notification:alert', alert: { ...base, kind: 'a-future-kind' as never } });
    expect(warning).not.toHaveBeenCalled();
  });
});
