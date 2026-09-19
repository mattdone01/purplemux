import { TYPED_CHUNK_GAP_MS, isPathOnlyPaste, planTypedInput, splitBracketedPaste } from '@/lib/typed-input';

export interface IStdinTypedWriterDeps {
  write: (data: string) => void;
  usesTyped: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The stdin seam of a browser terminal. Input is written straight through,
 * except a bracketed paste of text bound for a pane that wants its prompts
 * typed — see `typed-input.ts`. That paste is replayed as keystrokes, and everything that
 * arrives while the replay runs queues behind it, so the Enter a client sends
 * 100 ms after its paste cannot overtake the text it submits.
 */
export const createStdinTypedWriter = (deps: IStdinTypedWriterDeps): ((data: string) => void) => {
  const sleep = deps.sleep ?? realSleep;
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;

  const replay = async (data: string): Promise<void> => {
    const paste = splitBracketedPaste(data);
    if (!paste || isPathOnlyPaste(paste.body) || !(await deps.usesTyped().catch(() => false))) {
      deps.write(data);
      return;
    }
    if (paste.before) deps.write(paste.before);
    for (const step of planTypedInput(paste.body)) {
      deps.write(step.kind === 'newline' ? '\n' : step.text);
      await sleep(TYPED_CHUNK_GAP_MS);
    }
    if (paste.after) await replay(paste.after);
  };

  return (data: string): void => {
    if (queued === 0 && !splitBracketedPaste(data)) {
      deps.write(data);
      return;
    }
    queued += 1;
    tail = tail
      .then(() => replay(data))
      .catch(() => {})
      .finally(() => {
        queued -= 1;
      });
  };
};
