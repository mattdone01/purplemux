import { capturePaneContent, capturePaneContentWithHistory } from '@/lib/tmux';
import { pauseSession, resumeSession, resizeSessionPty, getActiveSessionSize } from '@/lib/terminal-server';

const NARROW_COLS_THRESHOLD = 50;
const SCROLLBACK_LINES = 50;
const PRE_CAPTURE_DELAY_MS = 300;
const POST_RESTORE_DELAY_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const capturePaneAtWidth = async (
  sessionName: string,
  cols: number,
  rows: number,
): Promise<string | null> => {
  const current = getActiveSessionSize(sessionName);

  if (current && current.cols > NARROW_COLS_THRESHOLD && current.rows >= rows) {
    return capturePaneContentWithHistory(sessionName, SCROLLBACK_LINES);
  }

  const orig = pauseSession(sessionName);
  if (!orig) return capturePaneContent(sessionName);

  try {
    resizeSessionPty(
      sessionName,
      Math.max(current?.cols ?? 0, cols),
      Math.max(current?.rows ?? 0, rows),
    );
    await sleep(PRE_CAPTURE_DELAY_MS);
    return await capturePaneContent(sessionName);
  } finally {
    // Resume first, then resize. A paused connection DROPS pty output rather
    // than buffering it, so a restore issued while still paused loses the very
    // redraw that repaints the client at its own width — the browser keeps a
    // stale frame and the TUI looks frozen. Both calls are synchronous and share
    // a tick, so no wide-geometry frame can slip out between them.
    resumeSession(sessionName);
    const restore = getActiveSessionSize(sessionName) ?? orig;
    resizeSessionPty(sessionName, restore.cols, restore.rows);
    await sleep(POST_RESTORE_DELAY_MS);
  }
};
