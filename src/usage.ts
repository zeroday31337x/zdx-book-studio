/**
 * Inference usage accounting: one event per model call, with real token
 * counts from the provider response (estimated only when a provider
 * returns none), latency, and cost from a configurable rate card.
 *
 * Rate card (env BOOK_STUDIO_MODEL_RATES, JSON) maps "provider:model",
 * "model", "provider:*" or "*" to { inputPer1M, outputPer1M } in USD.
 * Self-hosted inference-pool models default to $0/token: the pool is
 * owned infrastructure, so tokens + latency are the resource measures
 * and any dollar figure would be invented. Plug real rates in the env
 * when a paid provider is used; never hard-code a price here except the
 * Meta estimate the agent core already uses for its own accounting.
 */

export interface UsageEvent {
  id: string;
  ts: string;
  ownerEmail: string;
  bookId: string | null;
  chapterNumber: number | null;
  operation: string;
  agentId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokensEstimated: boolean;
  latencyMs: number;
  costUsd: number;
  status: "success" | "error";
}

export type UsageEventInput = Omit<UsageEvent, "id" | "ts" | "costUsd"> & { ts?: string };

interface Rate { inputPer1M: number; outputPer1M: number }

const DEFAULT_RATES: Record<string, Rate> = {
  "ollama:*": { inputPer1M: 0, outputPer1M: 0 },
  // Matches the estimate the ZDX agent core uses for Meta calls.
  "meta:*": { inputPer1M: 0.10, outputPer1M: 0.20 },
};

export function loadRateCard(env: NodeJS.ProcessEnv = process.env, overrideRaw?: string): Record<string, Rate> {
  const card: Record<string, Rate> = { ...DEFAULT_RATES };
  const raw = overrideRaw !== undefined ? overrideRaw : env.BOOK_STUDIO_MODEL_RATES;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, Partial<Rate>>;
      for (const [key, value] of Object.entries(parsed)) {
        card[key] = {
          inputPer1M: Math.max(0, Number(value?.inputPer1M) || 0),
          outputPer1M: Math.max(0, Number(value?.outputPer1M) || 0),
        };
      }
    } catch {
      console.warn("[BOOK_STUDIO_RATES] BOOK_STUDIO_MODEL_RATES is not valid JSON; using defaults");
    }
  }
  return card;
}

export function rateFor(card: Record<string, Rate>, provider: string, model: string): Rate {
  return (
    card[`${provider}:${model}`] ||
    card[model] ||
    card[`${provider}:*`] ||
    card["*"] ||
    { inputPer1M: 0, outputPer1M: 0 }
  );
}

export function costFor(card: Record<string, Rate>, provider: string, model: string, inputTokens: number, outputTokens: number): number {
  const rate = rateFor(card, provider, model);
  return Number(((inputTokens * rate.inputPer1M + outputTokens * rate.outputPer1M) / 1_000_000).toFixed(6));
}

/** Rough fallback when a provider response carries no usage block. */
export function estimateTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}
