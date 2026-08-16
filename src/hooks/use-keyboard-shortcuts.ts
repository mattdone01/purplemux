import { useCallback, useEffect, useRef } from 'react';
import { collectPanes, findAdjacentPaneInDirection, useLayoutStore } from '@/hooks/use-layout';
import type { TDirection } from '@/hooks/use-layout';
import { findResizeTarget } from '@/lib/layout-tree';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import useBoundHotkey from '@/hooks/use-bound-hotkey';
import useTabStore from '@/hooks/use-tab-store';
import { getAgentPanelTypeFromProvider, tryAgentSwitch } from '@/lib/agent-switch-lock';
import type { ILayoutData, IPaneNode, ITab, TPanelType } from '@/types/terminal';

const RESIZE_STEP_PERCENT = 5;
const MIN_RATIO = 5;
const MAX_RATIO = 95;

interface ILayoutActions {
  layout: ILayoutData | null;
  canSplit: boolean;
  paneCount: number;
  splitPane: (paneId: string, orientation: 'horizontal' | 'vertical') => Promise<void>;
  closePane: (paneId: string) => Promise<void>;
  focusPane: (paneId: string) => void;
  createTabInPane: (paneId: string, panelType?: TPanelType, command?: string) => Promise<ITab | null>;
  deleteTabInPane: (paneId: string, tabId: string) => Promise<void>;
}

interface IUseKeyboardShortcutsOptions {
  layout: ILayoutActions;
}

const getFocusedPane = (layout: ILayoutData | null): IPaneNode | null => {
  if (!layout?.activePaneId) return null;
  const panes = collectPanes(layout.root);
  return panes.find((p) => p.id === layout.activePaneId) ?? null;
};

const useKeyboardShortcuts = ({
  layout,
}: IUseKeyboardShortcutsOptions) => {
  const layoutRef = useRef(layout);
  const isSettingsDialogOpen = useWorkspaceStore((s) => s.isSettingsDialogOpen);
  const isCheatSheetOpen = useWorkspaceStore((s) => s.isCheatSheetOpen);
  const enabled = !isSettingsDialogOpen && !isCheatSheetOpen;

  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  useBoundHotkey('pane.split_right', () => {
    const l = layoutRef.current;
    if (!l.layout?.activePaneId || !l.canSplit) return;
    l.splitPane(l.layout.activePaneId, 'horizontal');
  }, enabled);

  useBoundHotkey('pane.split_down', () => {
    const l = layoutRef.current;
    if (!l.layout?.activePaneId || !l.canSplit) return;
    l.splitPane(l.layout.activePaneId, 'vertical');
  }, enabled);

  const focusDirection = useCallback((direction: TDirection) => {
    const l = layoutRef.current;
    if (!l.layout?.activePaneId) return;
    const targetId = findAdjacentPaneInDirection(
      l.layout.root,
      l.layout.activePaneId,
      direction,
    );
    if (targetId) l.focusPane(targetId);
  }, []);

  useBoundHotkey('pane.focus_left', () => focusDirection('left'), enabled);
  useBoundHotkey('pane.focus_right', () => focusDirection('right'), enabled);
  useBoundHotkey('pane.focus_up', () => focusDirection('up'), enabled);
  useBoundHotkey('pane.focus_down', () => focusDirection('down'), enabled);

  const resizeDirection = useCallback((direction: TDirection) => {
    const l = layoutRef.current;
    if (!l.layout?.activePaneId) return;
    const target = findResizeTarget(l.layout.root, l.layout.activePaneId, direction);
    if (!target) return;
    const delta = target.increase ? RESIZE_STEP_PERCENT : -RESIZE_STEP_PERCENT;
    const nextRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, target.currentRatio + delta));
    if (nextRatio === target.currentRatio) return;
    useLayoutStore.getState().updateRatio(target.path, nextRatio);
  }, []);

  useBoundHotkey('pane.resize_left', () => resizeDirection('left'), enabled);
  useBoundHotkey('pane.resize_right', () => resizeDirection('right'), enabled);
  useBoundHotkey('pane.resize_up', () => resizeDirection('up'), enabled);
  useBoundHotkey('pane.resize_down', () => resizeDirection('down'), enabled);

  useBoundHotkey(
    'pane.equalize',
    () => useLayoutStore.getState().equalizeRatios(),
    enabled,
  );

  useBoundHotkey('tab.new', () => {
    const l = layoutRef.current;
    if (!l.layout?.activePaneId) return;
    window.dispatchEvent(
      new CustomEvent('open-new-tab-menu', { detail: { paneId: l.layout.activePaneId } }),
    );
  }, enabled);

  useBoundHotkey('tab.close', () => {
    const l = layoutRef.current;
    if (!l.layout?.activePaneId) return;
    const pane = getFocusedPane(l.layout);
    if (!pane?.activeTabId) return;

    if (pane.tabs.length === 1 && l.paneCount > 1) {
      l.closePane(pane.id);
    } else {
      l.deleteTabInPane(pane.id, pane.activeTabId);
    }
  }, enabled);

  useBoundHotkey(
    'tab.prev',
    () => useLayoutStore.getState().focusPrevTab(),
    enabled,
  );

  useBoundHotkey(
    'tab.next',
    () => useLayoutStore.getState().focusNextTab(),
    enabled,
  );

  useBoundHotkey('pane.clear_screen', () => {}, enabled);

  useBoundHotkey(
    'tab.goto',
    (event) => {
      const digit = parseInt(event.code.replace('Digit', ''), 10);
      if (isNaN(digit) || digit < 1 || digit > 9) return;
      useLayoutStore.getState().focusTabByIndex(digit === 9 ? Infinity : digit - 1);
    },
    enabled,
  );

  const switchMode = useCallback((panelType: TPanelType) => {
    const l = layoutRef.current;
    const pane = getFocusedPane(l.layout);
    if (!pane?.activeTabId) return;
    const tab = pane.tabs.find((t) => t.id === pane.activeTabId);
    if (!tab) return;
    const current = tab.panelType ?? 'terminal';
    if (current === panelType) return;
    const tabState = useTabStore.getState().tabs[pane.activeTabId];
    if (!tryAgentSwitch({
      current,
      target: panelType,
      cliState: tabState?.cliState,
      agentProcess: tabState?.agentProcess,
      runningAgentPanelType: getAgentPanelTypeFromProvider(tabState?.agentProviderId),
    })) return;
    useLayoutStore.getState().updateTabPanelType(pane.id, pane.activeTabId, panelType);
  }, []);

  useBoundHotkey('view.mode_terminal', () => switchMode('terminal'), enabled);
  useBoundHotkey('view.mode_claude', () => switchMode('claude-code'), enabled);
  useBoundHotkey('view.mode_codex', () => switchMode('codex-cli'), enabled);
  useBoundHotkey('view.mode_grok', () => switchMode('grok-cli'), enabled);
  useBoundHotkey('view.mode_diff', () => {
    window.dispatchEvent(new CustomEvent('purplemux-toggle-git-panel'));
  }, enabled);
};

export default useKeyboardShortcuts;
