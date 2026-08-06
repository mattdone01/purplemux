/**
 * Signals are derived facts about how a worker is behaving, as opposed to
 * work-state events (`TAgentWorkStateEvent`) which describe where it is in its
 * turn lifecycle. A state event says "the turn ended"; a signal says "it spent
 * that turn editing files nobody asked for".
 */
export const AGENT_SIGNAL_KINDS = ['off-scope', 'thrash'] as const;
export type TAgentSignalKind = typeof AGENT_SIGNAL_KINDS[number];

export interface IAgentSignal {
  tabId: string;
  kind: TAgentSignalKind;
  /** One sentence, already phrased for the orchestrator. */
  detail: string;
  /** Concrete supporting items — paths, a command. Truncated by the engine. */
  evidence: string[];
  at: number;
}

/** One mutating tool call, normalized across agent CLIs. */
export interface IToolActivity {
  tool: string;
  /** Absolute paths the call wrote to. Empty for non-file tools. */
  paths: string[];
  failed: boolean;
  /**
   * Stable identity for a command, used to count repeats. A hash rather than
   * the text so the engine never holds command contents in memory.
   */
  commandKey?: string;
  /** Short, redacted excerpt shown as evidence when thrashing fires. */
  commandPreview?: string;
}
