export const MESSAGE_NAMESPACES = [
  'common', 'sidebar', 'header', 'terminal', 'connection',
  'workspace', 'login', 'onboarding', 'settings', 'stats',
  'reset', 'reports', 'timeline',
  'notification', 'session', 'messageHistory', 'webBrowser',
  'mobile', 'toolsRequired', 'diff', 'shortcuts',
  'orchestration',
] as const;

export type TMessageNamespace = (typeof MESSAGE_NAMESPACES)[number];
