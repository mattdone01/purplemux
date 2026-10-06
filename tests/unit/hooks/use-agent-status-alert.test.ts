import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { INotificationAlertMessage } from '@/types/status';

const warning = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({ toast: { warning } }));

import { showNotificationAlert } from '@/hooks/use-agent-status';

describe('status socket alerts', () => {
  beforeEach(() => warning.mockReset());

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
});
