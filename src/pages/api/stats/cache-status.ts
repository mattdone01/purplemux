import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { countCodexJsonlFiles } from '@/lib/stats/jsonl-parser-codex';
import { listClaudeProjectsDirs } from '@/lib/workspace-home';

const CACHE_PATH = path.join(os.homedir(), '.purplemux', 'stats', 'cache.json');

const countJsonlFiles = async (): Promise<number> => {
  let count = 0;
  for (const projectsRoot of await listClaudeProjectsDirs()) {
    const dirs = await fs.readdir(projectsRoot).catch(() => [] as string[]);
    for (const dir of dirs) {
      const dirPath = path.join(projectsRoot, dir);
      const stat = await fs.stat(dirPath).catch(() => null);
      if (!stat?.isDirectory()) continue;
      const files = await fs.readdir(dirPath).catch(() => []);
      count += files.filter((f) => f.endsWith('.jsonl') && !/^agent-/.test(f)).length;
    }
  }
  return count;
};

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method-not-allowed' });
  }

  const [claudeFileCount, codexFileCount] = await Promise.all([
    countJsonlFiles(),
    countCodexJsonlFiles(),
  ]);
  const fileCount = claudeFileCount + codexFileCount;

  try {
    await fs.access(CACHE_PATH);
    return res.status(200).json({ exists: true, fileCount });
  } catch {
    return res.status(200).json({ exists: false, fileCount });
  }
};

export default handler;
