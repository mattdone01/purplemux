import { withCodexTargetLock } from '@/lib/providers/codex/launch-lifecycle';
import { parseSessionName } from '@/lib/layout-store';
import { withOrchestrationMappingRead } from '@/lib/orchestration-mapping-lock';
import { recordOrchestrationSubmission } from '@/lib/orchestration-activity';

/** Raw bytes have no trustworthy turn boundary. Never inspect or buffer a prompt. */
export const withRecordedTerminalInput = <T>(sessionName: string, data: string, forward: () => Promise<T>, prior?: Promise<void>): Promise<T> => {
  const target = parseSessionName(sessionName);
  const work = async () => {
    await prior;
    if (target && data) await recordOrchestrationSubmission(sessionName, true);
    return forward();
  };
  return target ? withOrchestrationMappingRead(target.wsId, () => withCodexTargetLock(target.wsId, target.tabId, work)) : work();
};
