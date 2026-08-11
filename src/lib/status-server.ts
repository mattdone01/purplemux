import { WebSocket } from 'ws';
import { getStatusManager } from '@/lib/status-manager';
import { getSessionHistory } from '@/lib/session-history';
import { createLogger } from '@/lib/logger';
import type { TStatusClientMessage, IStatusSyncMessage, ISessionHistorySyncMessage } from '@/types/status';

const log = createLogger('status');

export const handleStatusConnection = (ws: WebSocket) => {
  const manager = getStatusManager();
  manager.addClient(ws);

  const syncMsg: IStatusSyncMessage = {
    type: 'status:sync',
    tabs: manager.getAllForClient(),
    standups: manager.getStandupsForClient(),
  };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(syncMsg));
  }

  getSessionHistory().then((entries) => {
    const historySync: ISessionHistorySyncMessage = { type: 'session-history:sync', entries };
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(historySync));
    }
  }).catch(() => {});

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as TStatusClientMessage;

      switch (msg.type) {
        case 'status:tab-dismissed':
          manager.dismissTab(msg.tabId, ws);
          break;

        case 'status:ack-notification':
          manager.ackNotificationInput(msg.tabId, msg.seq);
          break;

        case 'status:request-sync': {
          const sync: IStatusSyncMessage = {
            type: 'status:sync',
            tabs: manager.getAllForClient(),
            standups: manager.getStandupsForClient(),
          };
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(sync));
          }
          break;
        }

        default:
          log.warn(`Unknown event: ${(msg as { type: string }).type}`);
      }
    } catch {
      // invalid message
    }
  });

  ws.on('close', () => {
    manager.removeClient(ws);
  });

  ws.on('error', (err) => {
    log.error(`websocket error: ${err.message}`);
    manager.removeClient(ws);
  });
};

export const gracefulStatusShutdown = () => {
  getStatusManager().shutdown();
};
