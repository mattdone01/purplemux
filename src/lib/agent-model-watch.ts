import { getCodexModelStatus, type ICodexModelStatus } from '@/lib/providers/codex/model-observation';
import type { ITab } from '@/types/terminal';

export class AgentModelWatch {
  private mismatches = new Map<string, string>();

  constructor(private read = getCodexModelStatus) {}

  async check(tab: ITab, notify: (detail: string) => Promise<boolean>): Promise<void> {
    if (tab.panelType !== 'codex-cli' || !tab.agentLaunchConfig) {
      this.forget(tab.id);
      return;
    }
    const status: ICodexModelStatus = await this.read(tab);
    if (status.status !== 'mismatch') {
      if (status.status !== 'unknown') this.forget(tab.id);
      return;
    }
    const signature = JSON.stringify([status.expected, status.observed?.model, status.observed?.effort, status.observed?.sessionId]);
    if (this.mismatches.get(tab.id) === signature) return;
    const recorded = await notify(`expected ${status.expected.model ?? '(model unpinned)'}/${status.expected.effort ?? '(effort unpinned)'}, observed ${status.observed?.model ?? 'unknown'}/${status.observed?.effort ?? 'unknown'} from ${status.observed?.source ?? 'unknown'} at ${status.observed?.timestamp ?? 'unknown time'}`);
    if (recorded) this.mismatches.set(tab.id, signature);
  }

  forget(tabId: string): void { this.mismatches.delete(tabId); }
}
