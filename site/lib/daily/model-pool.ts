// ============================================================================
// the dAIly — Model Pool Registry
// ============================================================================
// Configurable registry of all frontier models in the forum pool.
// Each entry defines the provider, family, version, API config, and
// how to call the model. Adding or swapping a model is a config
// change here, not a code change elsewhere.
//
// The pool is editorial — only models from labs genuinely competing
// at the frontier are included. The composition reflects US, China,
// and European frontier labs.
//
// Every model in the pool uses its FLAGSHIP tier for all forum
// interactions (broadcast, debate, moderation). The cheaper tiers
// (Haiku, Flash, GPT-4o-mini) are used only for pipeline plumbing
// (Stage 2 organizers, embedding, moderation checks) and are NOT
// part of the pool.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

// --- Pool entry type ---

export interface PoolModel {
  /** Unique identifier in the pool (e.g., 'claude-opus') */
  id: string;
  /** Provider company name */
  provider: string;
  /** Model family (for lineage tracking in tagged memory) */
  family: string;
  /** Display name shown in the forum UI */
  displayName: string;
  /** Exact API model ID string sent to the provider */
  modelId: string;
  /** Country/region of the provider */
  region: 'US' | 'China' | 'EU';
  /** Provider API type — determines which client to use */
  apiType: 'anthropic' | 'openai' | 'openai-compatible' | 'google' | 'mistral';
  /** For openai-compatible providers: the base URL */
  baseUrl?: string;
  /** Environment variable name for the API key */
  apiKeyEnv: string;
  /** Date this model was added to the pool */
  dateAdded: string;
  /** Whether this model is currently active in the pool */
  active: boolean;
  /** Provider-side hard cap on max output tokens per call. Different
   *  providers have wildly different limits (DeepSeek: 8192, Anthropic
   *  Opus: 32k, Gemini 2.5 Pro: ~64k in thinking mode). callPoolModel()
   *  clamps any requested maxTokens to this value. Undefined means
   *  "no known cap — use whatever the caller asked for". */
  maxOutputTokens?: number;
}

// --- The pool ---

export const MODEL_POOL: PoolModel[] = [
  // --- US frontier labs ---
  {
    id: 'claude-opus',
    provider: 'Anthropic',
    family: 'Claude Opus',
    displayName: 'Claude Opus',
    modelId: 'claude-opus-4-6',
    region: 'US',
    apiType: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    maxOutputTokens: 32000,
  },
  {
    id: 'gpt-5',
    provider: 'OpenAI',
    family: 'GPT-5',
    displayName: 'GPT-5',
    modelId: 'gpt-5',
    region: 'US',
    apiType: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    maxOutputTokens: 32000,
  },
  {
    id: 'gemini-pro',
    provider: 'Google',
    family: 'Gemini Pro',
    displayName: 'Gemini Pro',
    modelId: 'gemini-2.5-pro',
    region: 'US',
    apiType: 'google',
    apiKeyEnv: 'GOOGLE_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    maxOutputTokens: 32000,
  },
  {
    id: 'llama',
    provider: 'Meta',
    family: 'Llama',
    displayName: 'Llama',
    modelId: 'llama-4-maverick-17b-128e-instruct', // update to latest flagship
    region: 'US',
    apiType: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    maxOutputTokens: 8192,
  },
  {
    id: 'grok',
    provider: 'xAI',
    family: 'Grok',
    displayName: 'Grok',
    modelId: 'grok-3', // update to latest flagship
    region: 'US',
    apiType: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    maxOutputTokens: 16000,
  },

  // --- China frontier labs ---
  {
    id: 'deepseek',
    provider: 'DeepSeek',
    family: 'DeepSeek',
    displayName: 'DeepSeek',
    modelId: 'deepseek-chat', // DeepSeek V3 or latest
    region: 'China',
    apiType: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    // DeepSeek's strict hard cap — anything above 8192 returns a 400
    // "Invalid max_tokens value" error. Clamp aggressively.
    maxOutputTokens: 8192,
  },
  {
    id: 'qwen',
    provider: 'Alibaba',
    family: 'Qwen',
    displayName: 'Qwen',
    modelId: 'qwen-max', // update to latest flagship
    region: 'China',
    apiType: 'openai-compatible',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'QWEN_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    maxOutputTokens: 8192,
  },
  {
    id: 'kimi',
    provider: 'Moonshot',
    family: 'Kimi',
    displayName: 'Kimi',
    modelId: 'kimi-k2-0711-preview', // update to latest flagship
    region: 'China',
    apiType: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'KIMI_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    maxOutputTokens: 8192,
  },

  // --- EU frontier labs ---
  {
    id: 'mistral',
    provider: 'Mistral',
    family: 'Mistral Large',
    displayName: 'Mistral Large',
    modelId: 'mistral-large-latest',
    region: 'EU',
    apiType: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    dateAdded: '2026-04-11',
    active: true,
    maxOutputTokens: 16000,
  },
];

// --- Helper functions ---

/** Get all active models in the pool. */
export function getActivePool(): PoolModel[] {
  return MODEL_POOL.filter(m => m.active);
}

/** Get all active models that have their API key configured. */
export function getAvailablePool(): PoolModel[] {
  return MODEL_POOL.filter(m => m.active && !!process.env[m.apiKeyEnv]);
}

/** Get models that are configured but skipped (no API key). */
export function getSkippedModels(): PoolModel[] {
  return MODEL_POOL.filter(m => m.active && !process.env[m.apiKeyEnv]);
}

/** Call a model with a system prompt + user prompt. Returns the text
 *  response or throws on failure. Handles all provider API types. */
export async function callPoolModel(
  model: PoolModel,
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 4000,
): Promise<string> {
  const apiKey = process.env[model.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`No API key for ${model.displayName} (env: ${model.apiKeyEnv})`);
  }

  // Clamp the caller's requested max tokens to the model's hard cap.
  // Each provider has a different ceiling (DeepSeek 8192, Opus 32k,
  // Gemini 2.5 Pro 64k, etc.) — without this clamp any caller passing
  // 16000 for Gemini thinking budget blows up on DeepSeek with a 400.
  const clampedMaxTokens = model.maxOutputTokens
    ? Math.min(maxTokens, model.maxOutputTokens)
    : maxTokens;
  if (clampedMaxTokens < maxTokens) {
    console.log(`[POOL] ${model.displayName} maxTokens clamped from ${maxTokens} to ${clampedMaxTokens}`);
  }

  switch (model.apiType) {
    case 'anthropic': {
      const client = new Anthropic();
      const response = await client.messages.create({
        model: model.modelId,
        max_tokens: clampedMaxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const block = response.content[0];
      return block?.type === 'text' ? block.text : '';
    }

    case 'openai': {
      const client = new OpenAI();
      // GPT-5 is a reasoning model — needs max_completion_tokens + reasoning_effort
      const isReasoning = model.modelId.startsWith('gpt-5');
      // Reasoning models want MORE budget than non-reasoning (thinking
      // tokens eat the visible output), but still clamp to the model's
      // hard cap. max_completion_tokens = min(maxTokens × 2, hard cap).
      const reasoningTokens = Math.min(
        clampedMaxTokens * 2,
        model.maxOutputTokens ?? clampedMaxTokens * 2,
      );
      const response = await client.chat.completions.create({
        model: model.modelId,
        max_completion_tokens: isReasoning ? reasoningTokens : clampedMaxTokens,
        ...(isReasoning ? { reasoning_effort: 'low' as const } : {}),
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return response.choices[0]?.message?.content || '';
    }

    case 'openai-compatible': {
      const client = new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
      });
      const response = await client.chat.completions.create({
        model: model.modelId,
        max_tokens: clampedMaxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return response.choices[0]?.message?.content || '';
    }

    case 'google': {
      const client = new GoogleGenAI({ apiKey });
      const response = await client.models.generateContent({
        model: model.modelId,
        contents: [
          { role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] },
        ],
        config: { maxOutputTokens: clampedMaxTokens },
      });
      return response.text || '';
    }

    case 'mistral': {
      // Mistral uses OpenAI-compatible API
      const client = new OpenAI({
        apiKey,
        baseURL: model.baseUrl,
      });
      const response = await client.chat.completions.create({
        model: model.modelId,
        max_tokens: clampedMaxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
      return response.choices[0]?.message?.content || '';
    }

    default:
      throw new Error(`Unknown API type: ${model.apiType}`);
  }
}
