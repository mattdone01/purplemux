import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { nanoid } from 'nanoid';
import type { TConnectionStatus, TDisconnectReason } from '@/types/terminal';
import {
  MSG_STDOUT,
  MSG_INPUT_ERROR,
  MSG_HEARTBEAT,
  encodeStdin,
  encodeWebStdin,
  encodeResize,
  encodeHeartbeat,
  decodeMessage,
  TAB_RESTARTING_CODE,
} from '@/lib/terminal-protocol';
import { shouldPromptMobileReloadRecovery } from '@/lib/ws-reload-recovery';

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];
const MAX_RETRIES = 5;
const HEARTBEAT_INTERVAL = 30_000;
const CLIENT_ID_PREFIX = 'pt-ws-cid-';
export const RESTART_RETRY_DELAY_MS = 1_000;
/** About as long as the server counts a restart as open (ADR-0028 §12). */
export const MAX_RESTART_RETRIES = 120;

export type TTerminalCloseAction =
  | { kind: 'session-ended' }
  | { kind: 'disconnected'; reason: Exclude<TDisconnectReason, null> }
  /** `restart`: a 4002 retry, counted apart so it spends none of the backoff budget. */
  | { kind: 'retry'; delay: number; restart: boolean }
  | { kind: 'exhausted' };

/**
 * What a terminal socket close means. 1000 is the only code that ends the
 * session (the caller closes the tab); 4002 is a restarting tab, re-attached
 * every second without spending the backoff budget (ADR-0028 §12).
 */
export const terminalCloseAction = (code: number, retries: number, restartRetries: number): TTerminalCloseAction => {
  if (code === 1000) return { kind: 'session-ended' };
  if (code === 1011) return { kind: 'disconnected', reason: 'session-not-found' };
  if (code === 1013) return { kind: 'disconnected', reason: 'max-connections' };
  if (code === TAB_RESTARTING_CODE && restartRetries < MAX_RESTART_RETRIES) {
    return { kind: 'retry', delay: RESTART_RETRY_DELAY_MS, restart: true };
  }
  if (retries < MAX_RETRIES) return { kind: 'retry', delay: RECONNECT_DELAYS[retries] ?? 16000, restart: false };
  return { kind: 'exhausted' };
};

const getOrCreateClientId = (sessionName: string): string => {
  const key = `${CLIENT_ID_PREFIX}${sessionName}`;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored) return stored;
    const id = nanoid();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return nanoid();
  }
};

interface IUseTerminalWebSocketOptions {
  onData?: (data: Uint8Array) => void;
  onConnected?: () => void;
  onSessionEnded?: () => void;
}

const useTerminalWebSocket = ({
  onData,
  onConnected,
  onSessionEnded,
}: IUseTerminalWebSocketOptions = {}) => {
  const [status, setStatus] = useState<TConnectionStatus>('disconnected');
  const [retryCount, setRetryCount] = useState(0);
  const [disconnectReason, setDisconnectReason] =
    useState<TDisconnectReason>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const restartRetryCountRef = useRef(0);
  const sessionNameRef = useRef('');
  const connectIdRef = useRef(0);
  const initialSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const callbacksRef = useRef({ onData, onConnected, onSessionEnded });
  const doConnectRef = useRef<(sessionName: string, connectId: number) => void>(() => {});

  useEffect(() => {
    callbacksRef.current = { onData, onConnected, onSessionEnded };
  }, [onData, onConnected, onSessionEnded]);

  const clearTimers = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const doConnect = useCallback(
    (sessionName: string, connectId: number) => {
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      setDisconnectReason(null);
      setStatus(retryCountRef.current > 0 || restartRetryCountRef.current > 0 ? 'reconnecting' : 'connecting');

      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const clientId = getOrCreateClientId(sessionName);
      const size = initialSizeRef.current;
      const sizeParams = size ? `&cols=${size.cols}&rows=${size.rows}` : '';
      const ws = new WebSocket(
        `${protocol}//${location.host}/api/terminal?clientId=${clientId}&session=${sessionName}${sizeParams}`,
      );
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (connectIdRef.current !== connectId) return;
        setStatus('connected');
        retryCountRef.current = 0;
        restartRetryCountRef.current = 0;
        setRetryCount(0);
        callbacksRef.current.onConnected?.();

        heartbeatRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(encodeHeartbeat());
          }
        }, HEARTBEAT_INTERVAL);
      };

      ws.onmessage = (event: MessageEvent) => {
        if (connectIdRef.current !== connectId) return;
        const { type, payload } = decodeMessage(event.data as ArrayBuffer);

        switch (type) {
          case MSG_STDOUT:
            callbacksRef.current.onData?.(payload);
            break;
          case MSG_INPUT_ERROR:
            toast.error(new TextDecoder().decode(payload));
            break;
          case MSG_HEARTBEAT:
            break;
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (connectIdRef.current !== connectId) return;
        clearTimers();
        wsRef.current = null;

        const action = terminalCloseAction(event.code, retryCountRef.current, restartRetryCountRef.current);
        if (action.kind === 'session-ended') {
          setStatus('session-ended');
          callbacksRef.current.onSessionEnded?.();
          return;
        }

        if (action.kind === 'disconnected') {
          setDisconnectReason(action.reason);
          setStatus('disconnected');
          return;
        }

        if (action.kind === 'retry') {
          if (action.restart) {
            restartRetryCountRef.current++;
          } else {
            retryCountRef.current++;
            setRetryCount(retryCountRef.current);
          }
          setStatus('reconnecting');
          retryTimerRef.current = setTimeout(() => {
            doConnectRef.current(sessionNameRef.current, connectId);
          }, action.delay);
        } else {
          if (shouldPromptMobileReloadRecovery()) {
            setDisconnectReason('reconnect-exhausted');
          }
          setStatus('disconnected');
        }
      };

      ws.onerror = () => {
        console.log('[terminal-ws] connection error');
      };
    },
    [clearTimers],
  );

  useEffect(() => {
    doConnectRef.current = doConnect;
  }, [doConnect]);

  const connect = useCallback(
    (sessionName: string, cols?: number, rows?: number) => {
      sessionNameRef.current = sessionName;
      initialSizeRef.current = cols && rows ? { cols, rows } : null;
      retryCountRef.current = 0;
      restartRetryCountRef.current = 0;
      setRetryCount(0);
      connectIdRef.current++;
      doConnect(sessionName, connectIdRef.current);
    },
    [doConnect],
  );

  const disconnect = useCallback(() => {
    connectIdRef.current++;
    clearTimers();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    sessionNameRef.current = '';
    setStatus('disconnected');
  }, [clearTimers]);

  const reconnect = useCallback(() => {
    if (!sessionNameRef.current) return;
    retryCountRef.current = 0;
    restartRetryCountRef.current = 0;
    setRetryCount(0);
    connectIdRef.current++;
    doConnect(sessionNameRef.current, connectIdRef.current);
  }, [doConnect]);

  const sendStdin = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeStdin(data));
    }
  }, []);

  const sendWebStdin = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeWebStdin(data));
    }
  }, []);

  const sendResize = useCallback((cols: number, rows: number) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(encodeResize(cols, rows));
    }
  }, []);

  useEffect(() => {
    return () => {
      connectIdRef.current++; // eslint-disable-line react-hooks/exhaustive-deps -- intentional mutation to invalidate pending callbacks
      clearTimers();
      if (wsRef.current) {
        wsRef.current.close(1000);
        wsRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (!sessionNameRef.current) return;
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
      retryCountRef.current = 0;
      restartRetryCountRef.current = 0;
      setRetryCount(0);
      connectIdRef.current++;
      doConnectRef.current(sessionNameRef.current, connectIdRef.current);
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return {
    status,
    retryCount,
    disconnectReason,
    connect,
    disconnect,
    reconnect,
    sendStdin,
    sendWebStdin,
    sendResize,
  };
};

export default useTerminalWebSocket;
