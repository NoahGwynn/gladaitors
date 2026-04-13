// ============================================================================
// dAIly Forum — Utterance Storage (tagged memory writer)
// ============================================================================
// Persists a cast member's spoken response to forum_utterances with:
// - Embedding via text-embedding-3-small (reuses lib/forum/embed.ts)
// - 1-3 topic tags assigned by a small LLM call (Sonnet — fast and
//   accurate enough for tag classification, much cheaper than flagship)
//
// Called by Stage 6 debate runtime after every participant turn. The
// stored row becomes part of the historical record that future debates
// query for the "you said X last week" feature.
//
// Tagging is the only LLM call here — embeddings are mechanical and
// the database insert is straightforward. Sonnet's tagging is good
// enough that we don't need flagship for this.
// ============================================================================

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@/lib/supabase';
import { generateEmbedding } from './embed';
import { getTaxonomy, filterValidTags } from './tag-taxonomy';

// --- Types ---

export interface StoreUtteranceOptions {
  sessionId: string;
  category: string;
  segmentName: string | null;     // null is allowed for things like opening framings
  turnIndex: number;              // 0-indexed position in the debate
  participantSeat: number;        // 1, 2, or 3
  modelId: string;                // exact, e.g. 'claude-opus'
  modelFamily: string;            // lineage, e.g. 'Claude Opus'
  utteranceText: string;
}

export interface StoredUtterance {
  id: string;
  tags: string[];
}

// --- Tagging via LLM ---

/** Ask Sonnet to assign 1-3 tags from the category taxonomy to an
 *  utterance. Returns the validated subset (silently drops any tag
 *  the model invented). */
async function tagUtterance(
  utteranceText: string,
  category: string,
): Promise<string[]> {
  const taxonomy = getTaxonomy(category);

  const prompt = `You are a topic classifier for the dAIly Forum, a daily AI investigation forum. A cast member has just spoken in a debate session for the ${category.toUpperCase()} category. Assign 1-3 topic tags from the fixed taxonomy below that best describe what their statement is about.

TAXONOMY (use only these exact tags):
${taxonomy.map(t => `- ${t}`).join('\n')}

UTTERANCE:
"""
${utteranceText.slice(0, 2000)}
"""

Pick 1-3 tags. Be specific — don't pick tags that are only loosely related. Use the exact tag strings from the taxonomy. If the utterance touches multiple distinct topics, use multiple tags. If it's narrowly about one topic, use one tag.

Respond with JSON only:
{ "tags": ["tag1", "tag2"] }`;

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

    // Parse the JSON response, tolerant of fences/whitespace
    let raw = text.trim();
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) raw = fence[1].trim();

    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1) return [];

    const parsed = JSON.parse(raw.slice(start, end + 1)) as { tags?: unknown };
    if (!Array.isArray(parsed.tags)) return [];

    const proposed = (parsed.tags as unknown[]).map(String);
    const valid = filterValidTags(category, proposed);

    // Cap at 3 tags
    return valid.slice(0, 3);
  } catch (err) {
    console.warn(`[UTTERANCE] Tagging failed: ${err instanceof Error ? err.message : 'unknown'}`);
    return [];
  }
}

// --- Main entry point ---

/** Persist a single utterance to forum_utterances. Generates the
 *  embedding, asks Sonnet to assign tags, then inserts. Returns the
 *  stored row's id and assigned tags. */
export async function storeUtterance(
  opts: StoreUtteranceOptions,
): Promise<StoredUtterance> {
  const supabase = createClient();

  // 1. Embed the utterance text (cheap, mechanical)
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(opts.utteranceText);
  } catch (err) {
    console.warn(`[UTTERANCE] Embedding failed: ${err instanceof Error ? err.message : 'unknown'}`);
    // Continue without embedding — the row is still useful for tag-based queries
  }

  // 2. Tag the utterance via LLM
  const tags = await tagUtterance(opts.utteranceText, opts.category);

  // 3. Insert
  const { data, error } = await supabase
    .from('forum_utterances')
    .insert({
      session_id: opts.sessionId,
      category: opts.category,
      segment_name: opts.segmentName,
      turn_index: opts.turnIndex,
      participant_seat: opts.participantSeat,
      model_id: opts.modelId,
      model_family: opts.modelFamily,
      utterance_text: opts.utteranceText,
      embedding,
      tags,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Failed to store utterance: ${error?.message || 'unknown'}`);
  }

  console.log(`[UTTERANCE] Stored ${data.id.slice(0, 8)} (seat ${opts.participantSeat}, ${opts.modelId}, tags: ${tags.join(', ') || 'none'})`);

  return { id: data.id, tags };
}
