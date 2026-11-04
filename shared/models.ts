/**
 * Models the user can pick from. Prices are USD per million tokens (list price,
 * Claude API) and are used only for the on-screen cost estimate.
 */
export interface ModelOption {
  id: string;
  label: string;
  note: string;
  price: { input: number; cacheWrite: number; cacheRead: number; output: number };
  /** Server-side refusal fallback ("fallbacks": "default") is not offered on every model. */
  supportsFallback: boolean;
}

export const MODELS: ModelOption[] = [
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    note: "Most thorough",
    price: { input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 },
    supportsFallback: true,
  },
  // Claude Sonnet 5.5 was removed after MODEL-COMPARISON.md: with this prompt (tuned for
  // Opus and Haiku, not Sonnet) it scored below Haiku at 18x the cost.
  {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    note: "Fastest, cheapest",
    price: { input: 0.1, cacheWrite: 0.125, cacheRead: 0.01, output: 0.5 },
    supportsFallback: false,
  },
];

export const DEFAULT_MODEL = MODELS[0].id;

export function findModel(id: string | undefined): ModelOption | undefined {
  return MODELS.find((m) => m.id === id);
}
