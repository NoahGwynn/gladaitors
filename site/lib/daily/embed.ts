// ============================================================================
// the dAIly — Embedding Generation
// ============================================================================
// Generates text embeddings via OpenAI's text-embedding-3-small model
// for thread matching. Each item's title + summary is embedded into a
// 1536-dimensional vector stored in the forum_items.embedding column.
//
// Cost: ~$0.00002 per embedding. 200 items/day = $0.004/day.
// ============================================================================

import OpenAI from 'openai';
import { createClient } from '@/lib/supabase';

const EMBEDDING_MODEL = 'text-embedding-3-small';
const BATCH_SIZE = 50; // OpenAI supports up to 2048 inputs per call

/** Generate a single embedding for a text string. */
export async function generateEmbedding(text: string): Promise<number[]> {
  const client = new OpenAI();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.slice(0, 8000), // cap input to avoid token limits
  });
  return response.data[0].embedding;
}

/** Generate embeddings for a batch of texts. Returns an array of
 *  vectors in the same order as the input texts. */
export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const client = new OpenAI();
  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts.map(t => t.slice(0, 8000)),
  });

  // Sort by index to preserve input order
  return response.data
    .sort((a, b) => a.index - b.index)
    .map(d => d.embedding);
}

/** Generate embeddings for all forum_items that don't have one yet.
 *  Processes in batches to respect API limits. Returns the count
 *  of items embedded. */
export async function embedNewItems(): Promise<number> {
  const supabase = createClient();

  // Find items without embeddings
  const { data: items, error } = await supabase
    .from('forum_items')
    .select('id, title, summary')
    .is('embedding', null)
    .order('ingested_at', { ascending: false })
    .limit(500); // cap per run to avoid runaway costs

  if (error || !items || items.length === 0) {
    if (error) console.error('[EMBED] Failed to load items:', error);
    return 0;
  }

  console.log(`[EMBED] ${items.length} items need embeddings`);
  let embedded = 0;

  // Process in batches
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const texts = batch.map(item =>
      `${item.title}${item.summary ? ' ' + item.summary : ''}`
    );

    try {
      const vectors = await generateEmbeddings(texts);

      // Update each item with its embedding
      for (let j = 0; j < batch.length; j++) {
        const { error: updateError } = await supabase
          .from('forum_items')
          .update({ embedding: JSON.stringify(vectors[j]) })
          .eq('id', batch[j].id);

        if (updateError) {
          console.error(`[EMBED] Failed to update item ${batch[j].id}:`, updateError.message);
        } else {
          embedded++;
        }
      }

      console.log(`[EMBED] Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} embedded`);
    } catch (err) {
      console.error('[EMBED] Batch failed:', err instanceof Error ? err.message : err);
    }
  }

  return embedded;
}
