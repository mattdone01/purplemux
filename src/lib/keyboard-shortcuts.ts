export const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform ?? navigator.userAgent);

const mod = isMac ? 'meta' : 'ctrl';
const secondaryMod = isMac ? 'ctrl' : 'alt';
const resizeMods = isMac ? 'meta+ctrl+shift' : 'ctrl+alt+shift';

export type TActionCategory =
  | 'workspace'
  | 'tab'
  | 'pane'
  | 'panel'
  | 'view'
  | 'app';

export type TKeybindingOverride = string | null;

export interface IAction {
  id: string;
  label: string;
  category: TActionCategory;
  defaultKey: string;
  display: { mac: string; other: string };
  editable?: boolean;
}

const numberKeys = (prefix: string) =>
  Array.from({ length: 9 }, (_, i) => `${prefix}+${i + 1}`).join(', ');

export const ACTIONS = {
  'workspace.new': {
    id: 'workspace.new',
    label: 'New workspace',
    category: 'workspace',
    defaultKey: `${mod}+n`,
    display: { mac: '⌘N', other: 'Ctrl+N' },
  },
  'workspace.rename': {
    id: 'workspace.rename',
    label: 'Rename workspace',
    category: 'workspace',
    defaultKey: `${mod}+shift+r`,
    display: { mac: '⌘⇧R', other: 'Ctrl+Shift+R' },
  },
  'workspace.switch': {
    id: 'workspace.switch',
    label: 'Switch to workspace 1–9',
    category: 'workspace',
    defaultKey: numberKeys(mod),
    display: { mac: '⌘1 – ⌘9', other: 'Ctrl+1 – Ctrl+9' },
    editable: false,
  },

  'tab.new': {
    id: 'tab.new',
    label: 'New tab',
    category: 'tab',
    defaultKey: `${mod}+t`,
    display: { mac: '⌘T', other: 'Ctrl+T' },
  },
  'tab.close': {
    id: 'tab.close',
    label: 'Close tab',
    category: 'tab',
    defaultKey: `${mod}+w`,
    display: { mac: '⌘W', other: 'Ctrl+W' },
  },
  'tab.prev': {
    id: 'tab.prev',
    label: 'Previous tab',
    category: 'tab',
    defaultKey: `${mod}+shift+BracketLeft`,
    display: { mac: '⌘⇧[', other: 'Ctrl+Shift+[' },
  },
  'tab.next': {
    id: 'tab.next',
    label: 'Next tab',
    category: 'tab',
    defaultKey: `${mod}+shift+BracketRight`,
    display: { mac: '⌘⇧]', other: 'Ctrl+Shift+]' },
  },
  'tab.goto': {
    id: 'tab.goto',
    label: 'Go to tab 1–9',
    category: 'tab',
    defaultKey: numberKeys(secondaryMod),
    display: { mac: '⌃1 – ⌃9', other: 'Alt+1 – Alt+9' },
    editable: false,
  },

  'pane.split_right': {
    id: 'pane.split_right',
    label: 'Split pane right',
    category: 'pane',
    defaultKey: `${mod}+d`,
    display: { mac: '⌘D', other: 'Ctrl+D' },
  },
  'pane.split_down': {
    id: 'pane.split_down',
    label: 'Split pane down',
    category: 'pane',
    defaultKey: `${mod}+shift+d`,
    display: { mac: '⌘⇧D', other: 'Ctrl+Shift+D' },
  },
  'pane.focus_left': {
    id: 'pane.focus_left',
    label: 'Focus left pane',
    category: 'pane',
    defaultKey: `${mod}+alt+ArrowLeft`,
    display: { mac: '⌘⌥←', other: 'Ctrl+Alt+←' },
  },
  'pane.focus_right': {
    id: 'pane.focus_right',
    label: 'Focus right pane',
    category: 'pane',
    defaultKey: `${mod}+alt+ArrowRight`,
    display: { mac: '⌘⌥→', other: 'Ctrl+Alt+→' },
  },
  'pane.focus_up': {
    id: 'pane.focus_up',
    label: 'Focus upper pane',
    category: 'pane',
    defaultKey: `${mod}+alt+ArrowUp`,
    display: { mac: '⌘⌥↑', other: 'Ctrl+Alt+↑' },
  },
  'pane.focus_down': {
    id: 'pane.focus_down',
    label: 'Focus lower pane',
    category: 'pane',
    defaultKey: `${mod}+alt+ArrowDown`,
    display: { mac: '⌘⌥↓', other: 'Ctrl+Alt+↓' },
  },
  'pane.clear_screen': {
    id: 'pane.clear_screen',
    label: 'Clear screen',
    category: 'pane',
    defaultKey: `${mod}+k`,
    display: { mac: '⌘K', other: 'Ctrl+K' },
  },
  'pane.resize_left': {
    id: 'pane.resize_left',
    label: 'Resize pane left',
    category: 'pane',
    defaultKey: `${resizeMods}+ArrowLeft`,
    display: { mac: '⌘⌃⇧←', other: 'Ctrl+Alt+Shift+←' },
  },
  'pane.resize_right': {
    id: 'pane.resize_right',
    label: 'Resize pane right',
    category: 'pane',
    defaultKey: `${resizeMods}+ArrowRight`,
    display: { mac: '⌘⌃⇧→', other: 'Ctrl+Alt+Shift+→' },
  },
  'pane.resize_up': {
    id: 'pane.resize_up',
    label: 'Resize pane up',
    category: 'pane',
    defaultKey: `${resizeMods}+ArrowUp`,
    display: { mac: '⌘⌃⇧↑', other: 'Ctrl+Alt+Shift+↑' },
  },
  'pane.resize_down': {
    id: 'pane.resize_down',
    label: 'Resize pane down',
    category: 'pane',
    defaultKey: `${resizeMods}+ArrowDown`,
    display: { mac: '⌘⌃⇧↓', other: 'Ctrl+Alt+Shift+↓' },
  },
  'pane.equalize': {
    id: 'pane.equalize',
    label: 'Equalize splits',
    category: 'pane',
    defaultKey: `${mod}+alt+Equal`,
    display: { mac: '⌘⌥=', other: 'Ctrl+Alt+=' },
  },

  'panel.focus_input': {
    id: 'panel.focus_input',
    label: 'Focus agent input',
    category: 'panel',
    defaultKey: `${mod}+i`,
    display: { mac: '⌘I', other: 'Ctrl+I' },
  },

  'view.toggle_sidebar': {
    id: 'view.toggle_sidebar',
    label: 'Toggle sidebar',
    category: 'view',
    defaultKey: `${mod}+b`,
    display: { mac: '⌘B', other: 'Ctrl+B' },
  },
  'view.toggle_sidebar_tab': {
    id: 'view.toggle_sidebar_tab',
    label: 'Switch Workspace ↔ Sessions',
    category: 'view',
    defaultKey: `${mod}+shift+b`,
    display: { mac: '⌘⇧B', other: 'Ctrl+Shift+B' },
  },
  'view.notes': {
    id: 'view.notes',
    label: 'Notes',
    category: 'view',
    defaultKey: `${mod}+shift+e`,
    display: { mac: '⌘⇧E', other: 'Ctrl+Shift+E' },
  },
  'view.stats': {
    id: 'view.stats',
    label: 'Stats',
    category: 'view',
    defaultKey: `${mod}+shift+u`,
    display: { mac: '⌘⇧U', other: 'Ctrl+Shift+U' },
  },
  'view.mode_terminal': {
    id: 'view.mode_terminal',
    label: 'Switch to Terminal mode',
    category: 'view',
    defaultKey: `${mod}+shift+t`,
    display: { mac: '⌘⇧T', other: 'Ctrl+Shift+T' },
  },
  'view.mode_claude': {
    id: 'view.mode_claude',
    label: 'Switch to Claude mode',
    category: 'view',
    defaultKey: `${mod}+shift+c`,
    display: { mac: '⌘⇧C', other: 'Ctrl+Shift+C' },
  },
  'view.mode_codex': {
    id: 'view.mode_codex',
    label: 'Switch to Codex mode',
    category: 'view',
    defaultKey: `${mod}+shift+x`,
    display: { mac: '⌘⇧X', other: 'Ctrl+Shift+X' },
  },
  'view.mode_grok': {
    id: 'view.mode_grok',
    label: 'Switch to Grok mode',
    category: 'view',
    defaultKey: `${mod}+shift+g`,
    display: { mac: '⌘⇧G', other: 'Ctrl+Shift+G' },
  },
  'view.mode_diff': {
    id: 'view.mode_diff',
    label: 'Toggle Git panel',
    category: 'view',
    defaultKey: `${mod}+shift+f`,
    display: { mac: '⌘⇧F', other: 'Ctrl+Shift+F' },
  },

  'app.settings': {
    id: 'app.settings',
    label: 'Settings',
    category: 'app',
    defaultKey: `${mod}+comma`,
    display: { mac: '⌘,', other: 'Ctrl+,' },
  },
  'app.new_window': {
    id: 'app.new_window',
    label: 'New window',
    category: 'app',
    defaultKey: `${mod}+shift+n`,
    display: { mac: '⌘⇧N', other: 'Ctrl+Shift+N' },
  },
} as const satisfies Record<string, IAction>;

export type TActionId = keyof typeof ACTIONS;

export const getActionIds = (): TActionId[] =>
  Object.keys(ACTIONS) as TActionId[];

export const isActionEditable = (id: TActionId): boolean => {
  const editable = (ACTIONS[id] as { editable?: boolean }).editable;
  return editable !== false;
};

const splitHotkeys = (value: string): string[] =>
  value.split(',').map((s) => s.trim()).filter(Boolean);

export const parseHotkeyToEventCode = (hotkey: string): string | null => {
  const parts = hotkey.split('+').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  let meta = false;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let code: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'meta' || lower === 'cmd' || lower === 'super') meta = true;
    else if (lower === 'ctrl' || lower === 'control') ctrl = true;
    else if (lower === 'alt' || lower === 'opt' || lower === 'option') alt = true;
    else if (lower === 'shift') shift = true;
    else if (/^[a-z]$/.test(lower)) code = `Key${lower.toUpperCase()}`;
    else if (/^[0-9]$/.test(lower)) code = `Digit${lower}`;
    else if (lower === 'comma') code = 'Comma';
    else if (lower === 'period') code = 'Period';
    else if (lower === 'slash') code = 'Slash';
    else if (lower === 'equal') code = 'Equal';
    else if (lower === 'minus') code = 'Minus';
    else if (lower === 'space') code = 'Space';
    else if (lower === 'enter' || lower === 'return') code = 'Enter';
    else if (lower === 'escape' || lower === 'esc') code = 'Escape';
    else if (lower === 'tab') code = 'Tab';
    else if (lower === 'backspace') code = 'Backspace';
    else code = part;
  }
  if (!code) return null;
  const out: string[] = [];
  if (meta) out.push('meta');
  if (ctrl) out.push('ctrl');
  if (alt) out.push('alt');
  if (shift) out.push('shift');
  out.push(code);
  return out.join('+');
};

export const formatHotkeyForDisplay = (hotkey: string): { mac: string; other: string } => {
  const parts = hotkey.split('+').map((s) => s.trim()).filter(Boolean);
  const macSyms: string[] = [];
  const otherSyms: string[] = [];
  let keyPart = '';
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === 'meta' || lower === 'cmd' || lower === 'super') {
      macSyms.push('⌘');
      otherSyms.push('Super');
    } else if (lower === 'ctrl' || lower === 'control') {
      macSyms.push('⌃');
      otherSyms.push('Ctrl');
    } else if (lower === 'alt' || lower === 'opt' || lower === 'option') {
      macSyms.push('⌥');
      otherSyms.push('Alt');
    } else if (lower === 'shift') {
      macSyms.push('⇧');
      otherSyms.push('Shift');
    } else {
      keyPart = formatKeyLabel(part);
    }
  }
  return {
    mac: `${macSyms.join('')}${keyPart}`,
    other: otherSyms.length ? `${otherSyms.join('+')}+${keyPart}` : keyPart,
  };
};

const formatKeyLabel = (key: string): string => {
  const lower = key.toLowerCase();
  if (lower === 'arrowleft') return '←';
  if (lower === 'arrowright') return '→';
  if (lower === 'arrowup') return '↑';
  if (lower === 'arrowdown') return '↓';
  if (lower === 'bracketleft') return '[';
  if (lower === 'bracketright') return ']';
  if (lower === 'comma') return ',';
  if (lower === 'period') return '.';
  if (lower === 'slash') return '/';
  if (lower === 'equal') return '=';
  if (lower === 'minus') return '-';
  if (lower === 'space') return 'Space';
  if (lower === 'enter' || lower === 'return') return 'Enter';
  if (lower === 'escape' || lower === 'esc') return 'Esc';
  if (lower === 'tab') return 'Tab';
  if (lower === 'backspace') return '⌫';
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase();
  return key;
};

let currentOverrides: Record<string, TKeybindingOverride> = {};
let shortcutSet: Set<string> = new Set();
const resolvedCache: Map<string, string | null> = new Map();
const eventCodeCache: Map<string, Set<string>> = new Map();
const subscribers = new Set<() => void>();

const rebuild = () => {
  resolvedCache.clear();
  eventCodeCache.clear();
  shortcutSet = new Set();
  for (const action of Object.values(ACTIONS)) {
    const override = currentOverrides[action.id];
    const key = override !== undefined ? override : action.defaultKey;
    resolvedCache.set(action.id, key);
    if (!key) continue;
    const codes = new Set<string>();
    for (const hotkey of splitHotkeys(key)) {
      const parsed = parseHotkeyToEventCode(hotkey);
      if (parsed) {
        codes.add(parsed);
        shortcutSet.add(parsed);
      }
    }
    eventCodeCache.set(action.id, codes);
  }
};
rebuild();

const overridesEqual = (
  a: Record<string, TKeybindingOverride>,
  b: Record<string, TKeybindingOverride>,
): boolean => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!(k in b)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
};

export const applyKeybindingOverrides = (
  overrides: Record<string, TKeybindingOverride>,
) => {
  if (overridesEqual(currentOverrides, overrides)) return;
  currentOverrides = { ...overrides };
  rebuild();
  for (const sub of subscribers) sub();
};

export const subscribeKeybindings = (cb: () => void): (() => void) => {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
};

export const getResolvedKey = (id: TActionId): string | null => {
  if (resolvedCache.has(id)) return resolvedCache.get(id) ?? null;
  return ACTIONS[id].defaultKey;
};

export const normalizeEvent = (e: KeyboardEvent): string => {
  const parts: string[] = [];
  if (e.metaKey) parts.push('meta');
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  parts.push(e.code);
  return parts.join('+');
};

export const isAppShortcut = (event: KeyboardEvent): boolean => {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return false;
  return shortcutSet.has(normalizeEvent(event));
};

export const matchesAction = (
  event: KeyboardEvent,
  id: TActionId,
): boolean => {
  const codes = eventCodeCache.get(id);
  if (!codes) return false;
  return codes.has(normalizeEvent(event));
};

export const isClearShortcut = (event: KeyboardEvent): boolean =>
  matchesAction(event, 'pane.clear_screen');

export const isFocusInputShortcut = (event: KeyboardEvent): boolean =>
  matchesAction(event, 'panel.focus_input');

export const isShiftEnter = (event: KeyboardEvent): boolean =>
  event.type === 'keydown' && event.key === 'Enter' && event.shiftKey;
