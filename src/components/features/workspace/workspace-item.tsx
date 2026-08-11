import { useCallback, useEffect, memo } from 'react';
import { Pencil, Trash2, FolderPlus, FolderMinus, Folder } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { ITab, IWorkspace } from '@/types/terminal';
import useTabStore, { selectWorkspacePortsLabel } from '@/hooks/use-tab-store';
import useWorkspaceStore from '@/hooks/use-workspace-store';
import useInlineEdit from '@/hooks/use-inline-edit';
import WorkspaceStatusIndicator from '@/components/features/workspace/workspace-status-indicator';
import WorkspaceStandup from '@/components/features/workspace/workspace-standup';

interface IWorkspaceItemProps {
  workspace: IWorkspace;
  isActive: boolean;
  isDeleting: boolean;
  shortcutLabel?: string;
  showShortcut: boolean;
  tabs?: ITab[];
  onSelect: (workspaceId: string) => void;
  onRename: (workspaceId: string, name: string) => void;
  onDelete: (workspaceId: string) => void;
}

const WorkspaceItem = ({
  workspace,
  isActive,
  isDeleting,
  shortcutLabel,
  showShortcut,
  tabs,
  onSelect,
  onRename,
  onDelete,
}: IWorkspaceItemProps) => {
  const t = useTranslations('terminal');
  const tc = useTranslations('common');
  const ts = useTranslations('sidebar');
  const groups = useWorkspaceStore((s) => s.groups);

  const { isEditing, draft, setDraft, inputRef, startEditing, commit, handleKeyDown } =
    useInlineEdit({
      value: workspace.name,
      onCommit: (next) => onRename(workspace.id, next),
      onEmpty: () =>
        (workspace.directories[0] ?? '').split('/').filter(Boolean).pop() || workspace.name,
    });

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail === workspace.id) {
        startEditing();
      }
    };
    window.addEventListener('rename-workspace', handler);
    return () => window.removeEventListener('rename-workspace', handler);
  }, [workspace.id, startEditing]);

  const handleClick = useCallback(() => {
    if (!isEditing && !isActive) {
      onSelect(workspace.id);
    }
  }, [isEditing, isActive, onSelect, workspace.id]);

  const handleMoveToGroup = useCallback((groupId: string | null) => {
    useWorkspaceStore.getState().moveWorkspaceToGroup(workspace.id, groupId);
  }, [workspace.id]);

  const handleCreateGroupAndMove = useCallback(async () => {
    const store = useWorkspaceStore.getState();
    const defaultName = ts('defaultGroupName');
    const group = await store.createGroup(defaultName);
    if (group) {
      store.moveWorkspaceToGroup(workspace.id, group.id);
    }
  }, [workspace.id, ts]);

  const displayDirs = workspace.directories.map((d) => d.replace(/^\/Users\/[^/]+/, '~'));
  const portsLabel = useTabStore((state) => selectWorkspacePortsLabel(state.tabs, workspace.id));

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className={cn(
          'relative flex cursor-pointer flex-col justify-center overflow-hidden border-l-2 px-3 py-2 transition-colors duration-75',
          isActive
            ? 'border-l-focus-indicator bg-accent text-foreground'
            : 'border-l-transparent text-muted-foreground hover:bg-sidebar-accent',
        )}
        style={{
          opacity: isDeleting ? 0.5 : 1,
          transition: 'opacity 150ms, background-color 75ms',
        }}
        onClick={handleClick}
        onDoubleClick={startEditing}
        role="button"
        aria-current={isActive ? 'true' : undefined}
        tabIndex={0}
        render={<div />}
      >
        {shortcutLabel && (
          <span
            className={cn(
              'absolute right-1.5 top-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium leading-none text-muted-foreground transition-opacity duration-200',
              showShortcut ? 'opacity-100' : 'opacity-0',
            )}
          >
            {shortcutLabel}
          </span>
        )}
        {isEditing ? (
          <input
            ref={inputRef}
            className="w-full border-b border-accent-color bg-transparent p-0 text-sm font-medium leading-tight text-foreground outline-none"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={commit}
          />
        ) : (
          <span className="truncate border-b border-transparent text-sm font-medium leading-tight">
            {workspace.name}
          </span>
        )}
        {displayDirs.map((dir, i) => (
          <span key={dir} className={cn('truncate text-xs leading-tight text-muted-foreground/70', i === 0 && 'mt-1')}>
            {dir}
          </span>
        ))}
        {portsLabel && (
          <span className="mt-1 truncate text-xs leading-tight text-ui-green/80">
            {portsLabel}
          </span>
        )}
        <WorkspaceStandup workspaceId={workspace.id} />
        <WorkspaceStatusIndicator workspaceId={workspace.id} tabs={tabs} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={startEditing}>
          <Pencil className="mr-2 h-3.5 w-3.5" />
          {t('rename')}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <Folder className="mr-2 h-3.5 w-3.5" />
            {ts('moveToGroup')}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {groups.map((g) => (
              <ContextMenuItem
                key={g.id}
                disabled={workspace.groupId === g.id}
                onClick={() => handleMoveToGroup(g.id)}
              >
                <Folder className="mr-2 h-3.5 w-3.5" />
                {g.name}
              </ContextMenuItem>
            ))}
            {groups.length > 0 && <ContextMenuSeparator />}
            <ContextMenuItem onClick={handleCreateGroupAndMove}>
              <FolderPlus className="mr-2 h-3.5 w-3.5" />
              {ts('newGroup')}
            </ContextMenuItem>
            {workspace.groupId && (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => handleMoveToGroup(null)}>
                  <FolderMinus className="mr-2 h-3.5 w-3.5" />
                  {ts('removeFromGroup')}
                </ContextMenuItem>
              </>
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          className="text-ui-red focus:text-ui-red"
          onClick={() => onDelete(workspace.id)}
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          {tc('delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
};

export default memo(WorkspaceItem);
