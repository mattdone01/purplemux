import { EventEmitter } from 'events';
import type { ISessionInfo } from '@/types/timeline';

interface IGrokHookEvents {
  on(event: 'session-info', listener: (tmuxSession: string, info: ISessionInfo) => void): this;
  emit(event: 'session-info', tmuxSession: string, info: ISessionInfo): boolean;
  off(event: 'session-info', listener: (tmuxSession: string, info: ISessionInfo) => void): this;
}

const g = globalThis as unknown as { __ptGrokHookEvents?: EventEmitter };
if (!g.__ptGrokHookEvents) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  g.__ptGrokHookEvents = emitter;
}

export const grokHookEvents = g.__ptGrokHookEvents as unknown as IGrokHookEvents;
