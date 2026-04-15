// ============================================================================
// the dAIly — Session pool colors
// ============================================================================
// Maps the 9-model forum pool to CSS colors for UI rendering (cast cards,
// debate argument stripes, journey timeline avatars). Extends the Arena's
// 3-family color palette (Claude/GPT/Gemini) with the additional labs
// that participate in the forum.
//
// Keep aligned with:
//   - lib/daily/model-pool.ts (the pool registry)
//   - styles/_variables.scss (for Claude/GPT/Gemini which match Arena)
// ============================================================================

/** Provider → hex color. Provider string matches model_pool.ts */
export const PROVIDER_COLORS: Record<string, string> = {
  Anthropic: '#D97757',  // orange (matches $model-claude)
  OpenAI: '#10A37F',     // teal (matches $model-gpt)
  Google: '#4285F4',     // blue (matches $model-gemini)
  xAI: '#F59E0B',        // amber (matches $model-grok)
  Meta: '#0866FF',       // Meta blue
  Alibaba: '#FF6A00',    // Alibaba orange
  DeepSeek: '#5D3FD3',   // deep purple
  Moonshot: '#D4A017',   // moonshot gold
  Mistral: '#FA520F',    // Mistral red-orange
};

/** Pool model id → CSS color. Resolves via MODEL_POOL's provider field. */
export function getPoolModelColor(modelId: string): string {
  // We import MODEL_POOL lazily to keep this module usable in RSC contexts
  // that don't want the full pool loaded. The pool is small and cheap.
  try {
    // Dynamic require to avoid circular issues
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MODEL_POOL } = require('./model-pool');
    interface PoolModel {
      id: string;
      provider: string;
    }
    const model = (MODEL_POOL as PoolModel[]).find((m) => m.id === modelId);
    if (!model) return '#8e8eae'; // text-muted fallback
    return PROVIDER_COLORS[model.provider] || '#8e8eae';
  } catch {
    return '#8e8eae';
  }
}

/** Provider string → CSS color with fallback. */
export function getProviderColor(provider: string | undefined): string {
  if (!provider) return '#8e8eae';
  return PROVIDER_COLORS[provider] || '#8e8eae';
}

/** The moderator's color — used for moderator turn cards. */
export const MODERATOR_COLOR = '#e5253f'; // brand red, same as $ui-accent
