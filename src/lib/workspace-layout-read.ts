import { promises as fs } from 'fs';
import { resolveLayoutFile } from '@/lib/layout-store';
import type { ILayoutData } from '@/types/terminal';

/** Diagnostic reads must never initialize a layout, start a session, or write a backup. */
export const readWorkspaceLayout = async (workspaceId: string): Promise<ILayoutData | null> => {
  let raw: string;
  try {
    raw = await fs.readFile(resolveLayoutFile(workspaceId), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const layout = JSON.parse(raw) as ILayoutData;
  if (!layout || typeof layout !== 'object' || !layout.root) throw new Error('Invalid workspace layout');
  return layout;
};
