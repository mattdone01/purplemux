import { useEffect, useRef } from 'react';
import { nanoid } from 'nanoid';
import useConfigStore from '@/hooks/use-config-store';
import { navigateToTab, navigateToTabOrCreate } from '@/hooks/use-layout';
import isElectron from '@/hooks/use-is-electron';

const urlBase64ToUint8Array = (base64String: string): ArrayBuffer => {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output.buffer as ArrayBuffer;
};

const DEVICE_ID_KEY = 'purplemux-device-id';

const getDeviceId = (): string => {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = nanoid();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
};

const postSubscription = (subscription: PushSubscriptionJSON) =>
  fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, deviceId: getDeviceId() }),
  });

const subscribe = async (): Promise<boolean> => {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return false;

    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await postSubscription(existing.toJSON());
      return true;
    }

    const res = await fetch('/api/push/vapid-key');
    const { publicKey } = await res.json();

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    await postSubscription(sub.toJSON());

    return true;
  } catch {
    return false;
  }
};

const unsubscribe = async (): Promise<void> => {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;

    await sub.unsubscribe();
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
  } catch {
    // 실패해도 무시
  }
};

// Re-posting the existing subscription binds it to this device, which is what
// keeps a focused desktop from muting the phone. Subscriptions registered before
// the binding existed would otherwise stay unbound until the toggle is cycled.
const syncExistingSubscription = async (): Promise<boolean> => {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    await postSubscription(sub.toJSON());
    return true;
  } catch {
    return false;
  }
};

export const getEndpoint = async (): Promise<string | null> => {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
};

const sendVisibility = (visible: boolean) => {
  fetch('/api/push/visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: getDeviceId(), visible }),
    keepalive: true,
  }).catch(() => {});
};

const PUSH_NAV_CACHE = 'push-nav';
const PUSH_NAV_KEY = '/_push-pending';

const consumePushNavCache = async (): Promise<Record<string, string | null> | null> => {
  try {
    if (typeof caches === 'undefined') return null;
    const cache = await caches.open(PUSH_NAV_CACHE);
    const res = await cache.match(PUSH_NAV_KEY);
    if (!res) return null;
    await cache.delete(PUSH_NAV_KEY);
    return await res.json();
  } catch {
    return null;
  }
};

const drainPushNavCache = async (): Promise<void> => {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open(PUSH_NAV_CACHE);
    await cache.delete(PUSH_NAV_KEY);
  } catch {
    // ignore
  }
};

export const registerPushTarget = async (sessionId: string): Promise<void> => {
  const endpoint = await getEndpoint();
  fetch('/api/push/register-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, sessionId }),
    keepalive: true,
  }).catch(() => {});
};

const useWebPush = () => {
  const initialized = useRef(false);

  useEffect(() => {
    if (isElectron) return;
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    const handlePushNavigation = (params: {
      workspaceId: string;
      tabId?: string;
      providerId?: string | null;
      claudeSessionId?: string | null;
      workspaceName?: string;
      workspaceDir?: string | null;
    }) => {
      const providerId = params.providerId === 'codex' ? 'codex' : 'claude';
      if (params.claudeSessionId) {
        navigateToTabOrCreate(
          params.workspaceId,
          params.tabId ?? '',
          params.claudeSessionId,
          params.workspaceName ?? '',
          params.workspaceDir ?? null,
          providerId,
        );
      } else if (params.tabId) {
        navigateToTab(params.workspaceId, params.tabId);
      }
    };

    const handleSwMessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.type === 'notification-click' && data.workspaceId) {
        drainPushNavCache();
        handlePushNavigation(data);
      }
    };
    navigator.serviceWorker.addEventListener('message', handleSwMessage);

    // iOS는 SW notificationclick이 client focus/visibilitychange보다 늦게 실행되므로
    // 즉시 1회 + 300ms 지연 재시도로 SW의 cache 쓰기가 끝난 뒤에도 잡는다.
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();
    const consumeAndNavigate = () => {
      consumePushNavCache().then((data) => {
        if (data?.workspaceId) {
          handlePushNavigation({
            workspaceId: data.workspaceId,
            tabId: data.tabId ?? undefined,
            providerId: data.providerId,
            claudeSessionId: data.claudeSessionId,
            workspaceName: data.workspaceName ?? '',
            workspaceDir: data.workspaceDir,
          });
        }
      });
    };
    const checkPushNavCache = () => {
      consumeAndNavigate();
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        consumeAndNavigate();
      }, 300);
      retryTimers.add(timer);
    };
    checkPushNavCache();

    const clearNotifications = () => {
      navigator.serviceWorker.ready.then((reg) => {
        reg.active?.postMessage({ type: 'clear-notifications' });
      });
      navigator.clearAppBadge?.();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        checkPushNavCache();
        clearNotifications();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const handlePageShow = () => {
      checkPushNavCache();
      clearNotifications();
    };
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('focus', handlePageShow);

    // 초기 로드: 기존 구독이 없으면 토글 OFF로 동기화
    syncExistingSubscription().then((exists) => {
      if (!exists) {
        const { notificationsEnabled } = useConfigStore.getState();
        if (notificationsEnabled) {
          useConfigStore.setState({ notificationsEnabled: false });
        }
      }
      initialized.current = true;
    });

    const unsub = useConfigStore.subscribe((state, prev) => {
      if (!initialized.current) return;
      if (state.notificationsEnabled === prev.notificationsEnabled) return;

      if (state.notificationsEnabled) {
        subscribe().then((ok) => {
          if (!ok) {
            useConfigStore.getState().setNotificationsEnabled(false);
          }
        });
      } else {
        unsubscribe();
      }
    });

    return () => {
      navigator.serviceWorker.removeEventListener('message', handleSwMessage);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handlePageShow);
      window.removeEventListener('focus', handlePageShow);
      retryTimers.forEach((t) => clearTimeout(t));
      retryTimers.clear();
      unsub();
    };
  }, []);

  // Visibility tracking (push 구독·SW 지원 여부와 무관하게 항상 실행)
  useEffect(() => {
    if (typeof window === 'undefined') return;

    sendVisibility(document.hasFocus());

    const handleFocus = () => sendVisibility(true);
    const handleBlur = () => sendVisibility(false);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    const pingTimer = setInterval(() => {
      if (document.hasFocus()) sendVisibility(true);
    }, 30_000);

    return () => {
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
      clearInterval(pingTimer);
      sendVisibility(false);
    };
  }, []);
};

export default useWebPush;
