import { recordOrchestrationSubmission } from '@/lib/orchestration-activity';
import { findTabBySessionName } from '@/lib/layout-store';
import { sendBracketedPasteText, sendTypedText, submitComposer } from '@/lib/tmux';
import { outcomeUnknownAfter } from '@/lib/remote-host';
import type { TPanelType } from '@/types/terminal';

/**
 * Claude Code treats a paste as untrusted data, so its prompts are typed. The
 * other agent TUIs take a paste as the prompt it is, and a paste is one tmux
 * call instead of one per chunk.
 */
export const usesTypedDelivery = (panelType: TPanelType | undefined): boolean =>
  panelType === 'claude-code';

export const sessionUsesTypedDelivery = async (sessionName: string): Promise<boolean> => {
  const tab = await findTabBySessionName(sessionName).catch(() => null);
  return usesTypedDelivery(tab?.panelType);
};

export interface IPromptDeliveryDeps {
  usesTyped: (sessionName: string) => Promise<boolean>;
  typeText: (sessionName: string, content: string) => Promise<void>;
  pasteText: (sessionName: string, content: string) => Promise<void>;
  submit: (sessionName: string) => Promise<void>;
  beforeSubmit?: (sessionName: string) => Promise<void>;
}

const defaultDeps: IPromptDeliveryDeps = {
  usesTyped: sessionUsesTypedDelivery,
  typeText: sendTypedText,
  pasteText: sendBracketedPasteText,
  submit: submitComposer,
  beforeSubmit: recordOrchestrationSubmission,
};

/** Put a prompt in the agent's composer WITHOUT submitting it. */
export const deliverPromptText = async (
  sessionName: string,
  content: string,
  deps: IPromptDeliveryDeps = defaultDeps,
): Promise<void> => {
  if (await deps.usesTyped(sessionName)) {
    await deps.typeText(sessionName, content);
    return;
  }
  await deps.pasteText(sessionName, content);
};

/**
 * Put a prompt in the agent's composer and submit it. A remote failure of the
 * submit, after the text landed, is outcome-unknown: a retry would type the
 * prompt a second time over the first (story 11 review r1, finding 1).
 */
export const deliverPrompt = async (
  sessionName: string,
  content: string,
  deps: IPromptDeliveryDeps = defaultDeps,
): Promise<void> => {
  await deps.beforeSubmit?.(sessionName);
  await deliverPromptText(sessionName, content, deps);
  await deps.submit(sessionName).catch((err: unknown) => {
    throw outcomeUnknownAfter(err, 'the prompt text');
  });
};
