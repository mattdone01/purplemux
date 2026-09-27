import os from 'os';
import path from 'path';
import { installHookScripts } from '@/lib/hook-scripts-install';

const USAGE = 'usage: install-hook-scripts.sh [--dir DIR]   (default ~/.purplemux)';

const parseDir = (args: string[]): string => {
  if (args.length === 0) return path.join(os.homedir(), '.purplemux');
  if (args.length === 2 && args[0] === '--dir' && args[1]) return path.resolve(args[1]);
  throw new Error(USAGE);
};

const main = async () => {
  const installed = await installHookScripts(parseDir(process.argv.slice(2)));
  for (const file of installed) console.log(`${file.changed ? 'WROTE' : 'SAME'} ${file.path}`);
};

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
