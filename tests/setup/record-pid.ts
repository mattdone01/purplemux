import fs from 'fs';
import path from 'path';
import { createLogger } from '@/lib/logger';

// Records this worker's pid for the end-of-run leak guard (tests/setup/isolated-home.ts).
const root = process.env.PMUX_TEST_HOME_ROOT;
if (root) {
  const dir = path.join(root, '.pids');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, String(process.pid)), '');
}

// The root logger is created once per worker and keeps the log directory it
// resolved first. Creating it here pins it to the run-wide isolated HOME, so a
// test that mocks `os.homedir()` to a temp dir and removes it can never leave
// the logger writing into a deleted directory (gate 26-r1: unhandled ENOENT).
createLogger('test');
