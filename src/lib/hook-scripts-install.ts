import fs from 'fs/promises';
import path from 'path';
import { HOOK_SCRIPT_FILES, writeScriptAtomic } from '@/lib/hook-scripts';

/**
 * Write every hook script into one directory, for `scripts/install-hook-scripts.ts`
 * (ADR-0020). No Next route may import this module: Turbopack cannot scope
 * `path.join(dir, name)` to a folder, so it would trace the whole project into
 * `.next/standalone`. That trace put a copy of `server.ts` beside the standalone
 * `server.js`, and tsx then loaded the copy in place of the Next server.
 */

export interface IInstalledHookScript {
  path: string;
  changed: boolean;
}

/** Write every hook script into `dir` (`~/.purplemux` on a live install). */
export const installHookScripts = async (dir: string): Promise<IInstalledHookScript[]> => {
  await fs.mkdir(dir, { recursive: true });
  const installed: IInstalledHookScript[] = [];
  for (const file of HOOK_SCRIPT_FILES) {
    const target = path.join(dir, file.name);
    installed.push({ path: target, changed: await writeScriptAtomic(target, file.content, file.mode) });
  }
  return installed;
};
