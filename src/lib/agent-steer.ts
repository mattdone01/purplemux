import { sendBracketedPaste, sendEscape, hasSession } from '@/lib/tmux';
import { createLogger } from '@/lib/logger';

const log = createLogger('steer');

/**
 * Correct a worker that is mid-turn.
 *
 * `tab send` types into the pane, so a busy agent queues the text until its
 * current turn ends — a correction sent two minutes into a twenty-minute
 * tangent lands eighteen minutes too late. Steering interrupts first, so the
 * correction is the next thing the agent reads.
 *
 * Both supported CLIs treat Escape as "stop the current turn, keep the
 * session", which is why this works for claude-code and codex-cli alike
 * without either one exposing a control API to us.
 */

/** Time for the CLI to unwind its turn and redraw a prompt before we type. */
const INTERRUPT_SETTLE_MS = 900;

export interface ISteerResult {
  ok: boolean;
  interrupted: boolean;
  reason?: string;
}

export const steerSession = async (
  sessionName: string,
  message: string,
  opts?: { interrupt?: boolean },
): Promise<ISteerResult> => {
  if (!message.trim()) return { ok: false, interrupted: false, reason: 'empty message' };
  if (!(await hasSession(sessionName))) {
    return { ok: false, interrupted: false, reason: 'session not found' };
  }

  // Default to interrupting: a steer aimed at a busy worker is the whole point,
  // and Escape on an already-idle agent is harmless.
  const interrupt = opts?.interrupt !== false;
  if (interrupt) {
    try {
      await sendEscape(sessionName);
      await new Promise((resolve) => setTimeout(resolve, INTERRUPT_SETTLE_MS));
    } catch (err) {
      // An interrupt that fails is not fatal — deliver the message anyway and
      // let it queue, which is still better than dropping the correction.
      log.warn(`interrupt failed for ${sessionName}: ${err instanceof Error ? err.message : err}`);
      return { ok: await deliver(sessionName, message), interrupted: false, reason: 'interrupt failed' };
    }
  }

  return { ok: await deliver(sessionName, message), interrupted: interrupt };
};

const deliver = async (sessionName: string, message: string): Promise<boolean> => {
  try {
    await sendBracketedPaste(sessionName, message);
    return true;
  } catch (err) {
    log.error(`steer delivery failed for ${sessionName}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
};
