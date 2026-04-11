// ============================================================================
// dAIly Forum — Seed Sources
// ============================================================================
// Inserts the configured source list into the forum_sources table.
// Idempotent — uses ON CONFLICT DO NOTHING so re-running is safe.
//
// Can be run via: npx tsx site/lib/forum/seed-sources.ts
// Or called from an API route during setup.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { ALL_SOURCES } from './sources';

async function seed() {
  // Use env vars directly since this runs outside Next.js
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
    process.exit(1);
  }

  const supabase = createClient(url, key);

  console.log(`Seeding ${ALL_SOURCES.length} sources...`);

  let inserted = 0;
  let skipped = 0;

  for (const source of ALL_SOURCES) {
    const { error } = await supabase
      .from('forum_sources')
      .insert({
        category: source.category,
        source_type: source.sourceType,
        name: source.name,
        url: source.url,
        config: source.config,
        enabled: true,
      });

    if (error) {
      if (error.code === '23505') {
        skipped++;
      } else {
        console.error(`  Failed: ${source.name} — ${error.message}`);
      }
    } else {
      inserted++;
      console.log(`  ✓ ${source.name}`);
    }
  }

  console.log(`\nDone: ${inserted} inserted, ${skipped} already existed.`);
}

seed().catch(console.error);
