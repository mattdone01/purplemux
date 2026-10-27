// USD per million tokens
// https://docs.anthropic.com/en/docs/about-claude/pricing
interface IModelPricing {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

const MODEL_PRICING: Record<string, IModelPricing> = {
  // Claude 5: Anthropic first-party price table (claude-api skill, cached 2026-10-06). Haiku 5.5 is its
  // <= 100K-prompt tier; the > 100K tier ($0.50 / $2.50) is not modelled.
  'fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  'fable-5': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  'opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  'opus-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'sonnet-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'haiku-5-5': { input: 0.1, output: 0.5, cacheWrite5m: 0.125, cacheWrite1h: 0.2, cacheRead: 0.01 },
  'opus-4-8': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'opus-4-7': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'opus-4-6': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'opus-4-5': { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  'opus-4-1': { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  'opus-4': { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  'sonnet-4-6': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'sonnet-4-5': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'sonnet-4': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'sonnet-3-7': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'sonnet-3-5': { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'haiku-4-5': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  'haiku-3-5': { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
  'haiku-3': { input: 0.25, output: 1.25, cacheWrite5m: 0.3, cacheWrite1h: 0.5, cacheRead: 0.03 },
  'opus-3': { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
};

// Fast-mode rates per model. cacheWrite5m/1h/cacheRead follow 1.25x / 2x / 0.1x of input.
const FAST_PRICING: Record<string, IModelPricing> = {
  'opus-4-8': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  'opus-4-6': { input: 30, output: 150, cacheWrite5m: 37.5, cacheWrite1h: 60, cacheRead: 3 },
};

const MODEL_DISPLAY_NAMES: Record<string, string> = {
  'fable-5-1': 'Fable 5.1',
  'fable-5': 'Fable 5',
  'opus-5-5': 'Opus 5.5',
  'opus-5': 'Opus 5',
  'sonnet-5-5': 'Sonnet 5.5',
  'sonnet-5': 'Sonnet 5',
  'haiku-5-5': 'Haiku 5.5',
  'opus-4-8': 'Opus 4.8',
  'opus-4-7': 'Opus 4.7',
  'opus-4-6': 'Opus 4.6',
  'opus-4-5': 'Opus 4.5',
  'opus-4-1': 'Opus 4.1',
  'opus-4': 'Opus 4',
  'sonnet-4-6': 'Sonnet 4.6',
  'sonnet-4-5': 'Sonnet 4.5',
  'sonnet-4': 'Sonnet 4',
  'sonnet-3-7': 'Sonnet 3.7',
  'sonnet-3-5': 'Sonnet 3.5',
  'haiku-4-5': 'Haiku 4.5',
  'haiku-3-5': 'Haiku 3.5',
  'haiku-3': 'Haiku 3',
  'opus-3': 'Opus 3',
};

// --- Model key extraction ---

const extractModelKey = (modelId: string): string | null => {
  const cleaned = modelId.replace(/\[.*?\]$/, '');
  // Version parts are 1-2 digits, so an 8-digit date suffix is never read as part of the key.
  const match = cleaned.match(/claude-(\w+-\d{1,2}(?:-\d{1,2})*)(?:-\d{8})?(?:-v\d)?(?:\:\d)?$/);
  return match ? match[1] : null;
};

export const normalizeModelName = (modelId: string): string => {
  const key = extractModelKey(modelId);
  return key ? `claude-${key}` : modelId;
};

export const formatModelDisplayName = (modelId: string): string => {
  const key = extractModelKey(modelId);
  if (key && MODEL_DISPLAY_NAMES[key]) return MODEL_DISPLAY_NAMES[key];
  const match = modelId.match(/claude-(\w+)/);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : modelId;
};

// --- Cost calculation ---

const computeCost = (pricing: IModelPricing, input: number, output: number, cache5m: number, cache1h: number, cacheRead: number): number => {
  const mtok = 1_000_000;
  return (
    (input / mtok) * pricing.input +
    (cache5m / mtok) * pricing.cacheWrite5m +
    (cache1h / mtok) * pricing.cacheWrite1h +
    (cacheRead / mtok) * pricing.cacheRead +
    (output / mtok) * pricing.output
  );
};

export const calculateCost = (
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreation5mTokens: number,
  cacheCreation1hTokens: number,
  cacheReadTokens: number,
  isFastMode = false,
): number | null => {
  const key = extractModelKey(modelId);
  if (!key) return null;

  const pricing = (isFastMode && FAST_PRICING[key])
    ? FAST_PRICING[key]
    : MODEL_PRICING[key];
  if (!pricing) return null;

  return computeCost(pricing, inputTokens, outputTokens, cacheCreation5mTokens, cacheCreation1hTokens, cacheReadTokens);
};

/**
 * Full model ID (e.g. "claude-opus-4-6") 기반 비용 계산.
 * 모델 키 추출 실패 시에는 이름 기반 fallback 요율을 적용해 대략치를 반환.
 */
export const calculateCostByFullId = (
  fullModelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreation5mTokens: number,
  cacheCreation1hTokens: number,
  cacheReadTokens: number,
): number => {
  const cost = calculateCost(
    fullModelId,
    inputTokens,
    outputTokens,
    cacheCreation5mTokens,
    cacheCreation1hTokens,
    cacheReadTokens,
  );
  if (cost !== null) return cost;

  const lower = fullModelId.toLowerCase();
  let pricing: IModelPricing;
  if (lower.includes('opus')) pricing = MODEL_PRICING['opus-4-6']!;
  else if (lower.includes('haiku')) pricing = MODEL_PRICING['haiku-4-5']!;
  else pricing = MODEL_PRICING['sonnet-4-6']!;

  return computeCost(pricing, inputTokens, outputTokens, cacheCreation5mTokens, cacheCreation1hTokens, cacheReadTokens);
};

// --- Token formatting ---

export const formatTokenCount = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toLocaleString();
};

export const formatTokenDetail = (count: number): string => {
  return count.toLocaleString();
};

export const formatCost = (cost: number): string => {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  if (cost >= 1_000) return `$${cost.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  return `$${cost.toFixed(2)}`;
};
