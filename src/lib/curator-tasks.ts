import type { TCuratorTask } from '@/types/curator';

// The curator's tasks (ADR-0038 §2): free-text classification only. Each task carries its prompt (versioned:
// the gate passes on one version), the labels the model may answer, and the rules that route when it does not.

export interface ICuratorStandingOrderRef {
  id: string;
  text: string;
}

export interface ICuratorTaskInput {
  text: string;
  /** match-standing-order: the orders in force for the asking tab's workspace. */
  orders?: readonly ICuratorStandingOrderRef[];
}

export interface ICuratorPrompt {
  system: string;
  user: string;
  labels: string[];
}

export interface ICuratorTaskSpec {
  task: TCuratorTask;
  promptVersion: string;
  /** The labels scored by the gate, in display order. */
  labels: readonly string[];
  prompt: (input: ICuratorTaskInput) => ICuratorPrompt;
  rules: (input: ICuratorTaskInput) => string;
}

export const OWNER_MESSAGE_CLASSES = ['standing-order', 'product-rule', 'answer', 'status-ping', 'one-off'] as const;
export const QUESTION_FLAGS = ['question-to-owner', 'not-a-question'] as const;
export const NOT_COVERED = 'not-covered';
/** match-standing-order is scored as covered or not; a covered label counts only when it names the gold order. */
export const COVERED = 'covered';

/** Display names for every label a face shows (pre-review item 1: never the wire token). */
export const CURATOR_LABEL_NAMES: Readonly<Record<string, string>> = {
  'standing-order': 'Standing order',
  'product-rule': 'Product rule',
  answer: 'Answer to a question',
  'status-ping': 'Status ask',
  'one-off': 'One-off instruction',
  'question-to-owner': 'Asks the owner',
  'not-a-question': 'Not a question',
  [COVERED]: 'Covered by a standing order',
  [NOT_COVERED]: 'Not covered',
};

export const CURATOR_TASK_NAMES: Readonly<Record<TCuratorTask, string>> = {
  'classify-owner-message': 'Owner message class',
  'flag-owner-question': 'Unmarked question flag',
  'match-standing-order': 'Standing-order match',
};

export const curatorTaskName = (task: string): string =>
  (Object.hasOwn(CURATOR_TASK_NAMES, task) ? CURATOR_TASK_NAMES[task as TCuratorTask] : 'Task not in the label map');

export const curatorLabelName = (label: string): string => {
  if (Object.hasOwn(CURATOR_LABEL_NAMES, label)) return CURATOR_LABEL_NAMES[label];
  if (/^SO-\d+$/.test(label)) return `Covered by ${label}`;
  return 'Label not in the label map';
};

const SPAN_RULE = 'Also return "span": the shortest exact quote (at most 120 characters) from the text that decided the label, copied verbatim.';

const ownerMessagePrompt = (input: ICuratorTaskInput): ICuratorPrompt => ({
  system: [
    'You classify one message the owner typed to an AI coding agent. Answer with JSON only.',
    'Classes:',
    '- standing-order: a rule for how agents should work from now on, beyond this task ("always...", "never...", "from now on", "stop asking me to...", a general working instruction).',
    '- product-rule: a rule about what the product or system must do or show (a requirement, a business rule, a data rule).',
    '- answer: a reply to a question an agent or a Mission Control item asked (yes/no, an option, a choice, a value it asked for).',
    '- status-ping: a bare ask for status, progress or an ETA, with no instruction.',
    '- one-off: an instruction or remark for the current task only, or anything else.',
    'When a message holds a standing rule and a one-off instruction, choose standing-order. Choose product-rule only for the product\'s behaviour, never for how agents work.',
    SPAN_RULE,
  ].join('\n'),
  user: `Message:\n"""\n${input.text}\n"""`,
  labels: [...OWNER_MESSAGE_CLASSES],
});

const questionPrompt = (input: ICuratorTaskInput): ICuratorPrompt => ({
  system: [
    'You read the end of an AI coding agent\'s turn. It carries no end-of-turn marker. Answer with JSON only.',
    '- question-to-owner: the agent asks the human owner a question, a decision, a permission or an input, and waits for the answer before it goes on.',
    '- not-a-question: a report, a summary, a plan it will carry out, a rhetorical question, a question to itself or to another agent, or an offer it does not wait on ("let me know if...").',
    SPAN_RULE,
  ].join('\n'),
  user: `End of turn:\n"""\n${input.text}\n"""`,
  labels: [...QUESTION_FLAGS],
});

const matchPrompt = (input: ICuratorTaskInput): ICuratorPrompt => {
  const orders = input.orders ?? [];
  return {
    system: [
      'An AI coding agent asks the owner for permission. Decide whether one standing order already answers it, so the agent may go ahead without asking. Answer with JSON only.',
      'Return the order id only when that order clearly and fully covers this exact ask. Money, production, irreversible or scope asks are never covered. When in doubt, return not-covered.',
      'Standing orders:',
      ...orders.map((order) => `${order.id}: ${order.text}`),
      SPAN_RULE,
    ].join('\n'),
    user: `Permission question:\n"""\n${input.text}\n"""`,
    labels: [...orders.map((order) => order.id), NOT_COVERED],
  };
};

// The rules route whenever the curator does not (ADR-0038 §6): markers and keyword patterns, never a model.
const STATUS_PING = /\b(status|progress|eta|where are we|how(?:'s| is) it going|any update|update\?)/i;
const STANDING = /\b(always|never|from now on|every time|whenever|going forward|in future|stop asking|don'?t ever|do not ever)\b/i;
const ANSWER = /^\s*(?:yes|no|yep|nope|ok(?:ay)?|approved?|go ahead|proceed|do it|option\s*[a-d]\b|\(?[a-d]\)?(?:\s|$|[.,:]))/i;
const PRODUCT = /\b(?:the (?:system|app|ui|screen|page|report|board|api|ledger|recon\w*) (?:should|must|needs to)|users? (?:should|must|can(?:not|'t)?)|business rule)\b/i;

const ownerMessageRules = ({ text }: ICuratorTaskInput): string => {
  const trimmed = text.trim();
  if (STANDING.test(trimmed)) return 'standing-order';
  if (PRODUCT.test(trimmed)) return 'product-rule';
  if (ANSWER.test(trimmed)) return 'answer';
  if (trimmed.length <= 80 && STATUS_PING.test(trimmed)) return 'status-ping';
  return 'one-off';
};

/**
 * A turn ending reaches flag-owner-question only when its last three lines hold a '?' (measured 2026-11-03: 674 of
 * 38,977 unmarked ws-ldhziO turn endings, 1.7%). The rest never ask, the GPU is shared with kodit, and the gate's
 * precision is measured on exactly the endings the curator sees.
 */
export const endingAsksSomething = (text: string): boolean =>
  text.trim().split('\n').filter((line) => line.trim()).slice(-3).join('\n').includes('?');

const ASKS_OWNER = /\b(you|your|shall i|should i|do you|would you|want me|can you|which|confirm|approve|ok to|okay to|go ahead)\b/i;

const questionRules = ({ text }: ICuratorTaskInput): string => {
  const tail = text.trim().split('\n').filter((line) => line.trim()).slice(-3).join('\n');
  return endingAsksSomething(text) && ASKS_OWNER.test(tail) ? 'question-to-owner' : 'not-a-question';
};

export const CURATOR_MODEL = 'gemma4:26b';

/** What every call sends besides the messages and the schema: part of a prompt's identity (review r2 F1). */
export const CURATOR_REQUEST_OPTIONS = { stream: false, think: false, options: { temperature: 0 } } as const;

/** The JSON schema Ollama constrains the reply to: the label is an enum, so it cannot invent one. */
export const replySchema = (labels: readonly string[]) => ({
  type: 'object',
  properties: { label: { type: 'string', enum: [...labels] }, span: { type: 'string' } },
  required: ['label', 'span'],
});

/** FNV-1a, 32 bits, as 8 hex: pure, so the browser bundle that names tasks can import this file. */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
};

const PLACEHOLDER: ICuratorTaskInput = { text: '\u0000TEXT\u0000', orders: [{ id: '\u0000ID\u0000', text: '\u0000ORDER\u0000' }] };

/**
 * A prompt's identity: the model, the request options, the template rendered on placeholders, its labels and the reply
 * schema, hashed (review r1 F6, r2 F1). Any edit to the prompt or a model change gives a new version, so a gate passed by
 * one never carries to another: a new version has its own clock and evidence.
 */
export const promptHash = (
  prompt: ICuratorTaskSpec['prompt'],
  labels: readonly string[],
  model: string = CURATOR_MODEL,
  request: object = CURATOR_REQUEST_OPTIONS,
): string => {
  const rendered = prompt(PLACEHOLDER);
  return fnv1a(JSON.stringify({
    model, request, system: rendered.system, user: rendered.user, labels, offered: rendered.labels, schema: replySchema(rendered.labels),
  }));
};

const spec = (task: TCuratorTask, base: string, labels: readonly string[], prompt: ICuratorTaskSpec['prompt'], rules: ICuratorTaskSpec['rules']): ICuratorTaskSpec =>
  ({ task, promptVersion: `${base}-${promptHash(prompt, labels)}`, labels, prompt, rules });

export const CURATOR_TASKS: Readonly<Record<TCuratorTask, ICuratorTaskSpec>> = {
  'classify-owner-message': spec('classify-owner-message', 'com-v1', OWNER_MESSAGE_CLASSES, ownerMessagePrompt, ownerMessageRules),
  'flag-owner-question': spec('flag-owner-question', 'foq-v1', QUESTION_FLAGS, questionPrompt, questionRules),
  // The rules never cover a permission question: a standing-order answer comes only from a gated model (ADR-0038 §4).
  'match-standing-order': spec('match-standing-order', 'mso-v1', [COVERED, NOT_COVERED], matchPrompt, () => NOT_COVERED),
};

export const CURATOR_TASK_IDS = Object.keys(CURATOR_TASKS) as TCuratorTask[];

export const isCuratorTask = (value: unknown): value is TCuratorTask =>
  typeof value === 'string' && Object.hasOwn(CURATOR_TASKS, value);
