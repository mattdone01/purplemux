import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { INotificationAlertMessage } from '@/types/status';

const warning = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({ toast: { warning } }));

import { showNotificationAlert } from '@/hooks/use-agent-status';

describe('status socket alerts', () => {
  beforeEach(() => warning.mockReset());

  it('presents a foreground orchestrator-missing alert through the client toast path', () => {
    const message: INotificationAlertMessage = {
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

    showNotificationAlert(message);

    expect(warning).toHaveBeenCalledWith('Orchestrator Missing', {
      id: 'alert-1',
      description: 'Work remains but no orchestrator is designated.',
    });
  });
});
