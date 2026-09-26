import fs from 'fs';
import path from 'path';

const root = process.env.PMUX_TEST_HOME_ROOT;
if (root) {
  // Records this worker's pid for the end-of-run leak guard (tests/setup/isolated-home.ts).
  const pids = path.join(root, '.pids');
  fs.mkdirSync(pids, { recursive: true });
  fs.writeFileSync(path.join(pids, String(process.pid)), '');
  // One HOME per worker, so parallel test files never share a ~/.purplemux.
  const home = path.join(root, `w-${process.pid}`);
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
}

// The root logger is created once per worker and keeps the log directory it
// resolved first. Creating it here pins it to the worker's isolated HOME, so a
// test that mocks `os.homedir()` to a temp dir and removes it can never leave
// the logger writing into a deleted directory (gate 26-r1: unhandled ENOENT).
// Importing the module creates the root logger; it is imported only now, because
// a static import would load it before HOME moved.
const { createLogger } = await import('@/lib/logger');
createLogger('test');
