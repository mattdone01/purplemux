import { sendEscape, hasSessionOrUnreachable } from '@/lib/tmux';
import { deliverPrompt } from '@/lib/agent-prompt-delivery';
import { RemoteHostError } from '@/lib/remote-host';
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
 * Whether a steer interrupts is the caller's decision, never a default here: the
 * route decides it per caller (`@/lib/steer-policy`, harness-flow-loop-2 story 14),
 * because an Escape abandons the target's turn.
 *
 * Both supported CLIs treat Escape as "stop the current turn, keep the
 * session", which is why this works for claude-code and codex-cli alike
 * without either one exposing a control API to us.
 *
 * A remote tab's host that does not answer over ssh is `unreachable`, never "session not found"
 * (harness-flow-loop-2 story 11): the route answers 503 `remote-host-unreachable`, which a caller may
 * retry, where `session-not-running` tells it never to.
 */

/** Time for the CLI to unwind its turn and redraw a prompt before we type. */
const INTERRUPT_SETTLE_MS = 900;

export interface ISteerResult {
  ok: boolean;
  interrupted: boolean;
  reason?: string;
  /** The remote host did not answer over ssh: whether the session lives is not known. */
  unreachable?: { host: string; message: string };
}

const unreachable = (err: RemoteHostError, interrupted: boolean): ISteerResult => ({
  ok: false,
  interrupted,
  reason: err.message,
  unreachable: { host: err.host, message: err.message },
});

export const steerSession = async (
  sessionName: string,
  message: string,
  opts: { interrupt: boolean; beforeDeliver?: () => Promise<boolean> },
): Promise<ISteerResult> => {
  if (!message.trim()) return { ok: false, interrupted: false, reason: 'empty message' };
  let interrupted = false;
  try {
    if (!(await hasSessionOrUnreachable(sessionName))) {
      return { ok: false, interrupted: false, reason: 'session not found' };
    }
    if (opts.interrupt) {
      try {
        await sendEscape(sessionName);
        interrupted = true;
        await new Promise((resolve) => setTimeout(resolve, INTERRUPT_SETTLE_MS));
      } catch (err) {
        // An interrupt that fails is not fatal — deliver the message anyway and
        // let it queue, which is still better than dropping the correction.
        log.warn(`interrupt failed for ${sessionName}: ${err instanceof Error ? err.message : err}`);
        return { ok: await deliver(sessionName, message, opts.beforeDeliver), interrupted: false, reason: 'interrupt failed' };
      }
    }
    return { ok: await deliver(sessionName, message, opts.beforeDeliver), interrupted };
  } catch (err) {
    if (err instanceof RemoteHostError) return unreachable(err, interrupted);
    throw err;
  }
};

/** False when the message was not delivered; a remote host that did not answer throws `RemoteHostError`. */
const deliver = async (
  sessionName: string,
  message: string,
  beforeDeliver?: () => Promise<boolean>,
): Promise<boolean> => {
  try {
    if (!await hasSessionOrUnreachable(sessionName)) return false;
    if (beforeDeliver && !await beforeDeliver()) return false;
    await deliverPrompt(sessionName, message);
    return true;
  } catch (err) {
    if (err instanceof RemoteHostError) throw err;
    log.error(`steer delivery failed for ${sessionName}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
};
