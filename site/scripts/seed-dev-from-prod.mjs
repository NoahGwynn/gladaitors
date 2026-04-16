#!/usr/bin/env node
// ============================================================================
// Seed the dev Supabase project with a recent snapshot from prod.
// ============================================================================
// One-off utility. Reads recent news data from PROD (via env vars) and
// writes it into DEV (using the regular .env Supabase creds — which
// should be pointing at the dev project by the time you run this).
//
// What it copies:
//   - forum_sources (all — they don't change often and are small)
//   - forum_threads (the most recent N by last_event)
//   - forum_items    (every item attached to those threads)
//   - debates        (public debates only + the configured sample debate)
//
// What it does NOT copy:
//   - forum_sessions   — dev should start with an empty session history
//   - forum_utterances — dev starts with no prior debate memory
//   - private debates  — anything with owner_only=true is excluded
//   - user / session linkage on debates — creator_user_id, creator_session_id,
//                                          driver_session_id, etc. are nulled
//                                          so dev rows aren't tied to prod auth
//   - private reflective fields — what_would_change_my_mind and user_decision
//                                  are nulled (they belong to the prod user)
//
// Usage:
//   cd site
//   PROD_SUPABASE_URL=https://<prod-project-id>.supabase.co \
//   PROD_SUPABASE_KEY=<prod-service-role-key> \
//     node scripts/seed-dev-from-prod.mjs
//
// The DEV credentials come from your .env file automatically — make
// sure NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY point at
// the dev project before you run this script.
//
// Safe to re-run: upserts on primary key so duplicate runs just refresh.
// ============================================================================

import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load the site's .env file (DEV credentials)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, '..', '.env') });

// --- Config ---

/** How many of the most-recent threads to pull from prod. */
const RECENT_THREAD_COUNT = Number.parseInt(process.env.SEED_THREAD_COUNT || '200', 10);

/** How many of the most-recent public debates to pull from prod. */
const RECENT_DEBATE_COUNT = Number.parseInt(process.env.SEED_DEBATE_COUNT || '100', 10);

/** The hero "example" debate — always pulled even if not public so the
 *  hero on /journal/debate has a real sample to render. Lives in
 *  lib/config.ts as `sampleDebateId`. Override via env if you've
 *  changed it. */
const SAMPLE_DEBATE_ID =
  process.env.SEED_SAMPLE_DEBATE_ID || '50925839-5527-4838-ad9d-68a4e43a54a3';

/** Insert batch size — Supabase REST API starts degrading above ~1000/row. */
const INSERT_BATCH_SIZE = 500;

// --- Clients ---

const PROD_URL = process.env.PROD_SUPABASE_URL;
const PROD_KEY = process.env.PROD_SUPABASE_KEY;
if (!PROD_URL || !PROD_KEY) {
  console.error('Missing PROD_SUPABASE_URL and/or PROD_SUPABASE_KEY env vars.');
  console.error('Usage: PROD_SUPABASE_URL=... PROD_SUPABASE_KEY=... node scripts/seed-dev-from-prod.mjs');
  process.exit(1);
}

const DEV_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const DEV_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!DEV_URL || !DEV_KEY) {
  console.error('Missing dev credentials in .env (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).');
  process.exit(1);
}

if (DEV_URL === PROD_URL) {
  console.error('REFUSING: DEV and PROD URLs are the same. Update .env to point at the dev project first.');
  process.exit(1);
}

console.log(`PROD: ${PROD_URL}`);
console.log(`DEV:  ${DEV_URL}`);
console.log(`Copying most recent ${RECENT_THREAD_COUNT} threads + their items.\n`);

const prod = createClient(PROD_URL, PROD_KEY, { auth: { persistSession: false } });
const dev = createClient(DEV_URL, DEV_KEY, { auth: { persistSession: false } });

// --- Helpers ---

async function insertInBatches(table, rows) {
  if (rows.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const { error } = await dev.from(table).upsert(batch, { onConflict: 'id' });
    if (error) {
      console.error(`  ERROR inserting into ${table}: ${error.message}`);
      throw error;
    }
    inserted += batch.length;
    process.stdout.write(`  ${inserted}/${rows.length}\r`);
  }
  process.stdout.write('\n');
  return inserted;
}

// --- Main ---

/** Strip prod user/session linkage and private reflective fields from a
 *  debate row before writing into dev. Keeps the public-facing content
 *  (topic, positions, models, arguments, synthesis, moderation) intact
 *  so the dev copy renders identically — but with no tie back to the
 *  prod user who created it. */
function sanitiseDebate(row) {
  return {
    ...row,
    creator_user_id: null,
    creator_session_id: null,
    driver_session_id: null,
    driver_heartbeat_at: null,
    // Force link-shareable so the dev copy is viewable without an owner.
    owner_only: false,
    // Private reflective fields belong to the prod user — don't copy.
    what_would_change_my_mind: null,
    user_decision: null,
  };
}

async function main() {
  // 1. forum_sources — copy all
  console.log('1/4  Fetching forum_sources from prod...');
  const { data: sources, error: sourcesErr } = await prod
    .from('forum_sources')
    .select('*');
  if (sourcesErr) throw sourcesErr;
  console.log(`      got ${sources.length} sources`);
  console.log('      upserting into dev...');
  await insertInBatches('forum_sources', sources);

  // 2. forum_threads — most recent N (ordered by last_event_at)
  console.log(`\n2/4  Fetching most recent ${RECENT_THREAD_COUNT} threads from prod...`);
  const { data: threads, error: threadsErr } = await prod
    .from('forum_threads')
    .select('*')
    .order('last_event_at', { ascending: false, nullsFirst: false })
    .limit(RECENT_THREAD_COUNT);
  if (threadsErr) throw threadsErr;
  console.log(`      got ${threads.length} threads`);

  // Reset session-related fields so dev threads look "active" again
  const cleanedThreads = threads.map(t => ({
    ...t,
    status: 'active',
    discussed_at: null,
    session_id: null,
  }));

  console.log('      upserting into dev (with status=active, session links cleared)...');
  await insertInBatches('forum_threads', cleanedThreads);

  // 3. forum_items — everything belonging to those threads
  console.log(`\n3/4  Fetching forum_items for ${threads.length} threads from prod...`);
  const threadIds = threads.map(t => t.id);

  // Fetch in chunks to avoid URL-length limits on the .in() filter
  const IN_CHUNK = 50;
  const allItems = [];
  for (let i = 0; i < threadIds.length; i += IN_CHUNK) {
    const chunk = threadIds.slice(i, i + IN_CHUNK);
    const { data: items, error: itemsErr } = await prod
      .from('forum_items')
      .select('*')
      .in('thread_id', chunk);
    if (itemsErr) throw itemsErr;
    allItems.push(...items);
    process.stdout.write(`      fetched ${allItems.length} items...\r`);
  }
  process.stdout.write('\n');

  console.log(`      got ${allItems.length} items`);
  console.log('      upserting into dev...');
  await insertInBatches('forum_items', allItems);

  // 4. debates — public debates + the configured sample. Sensitive
  //    fields (user/session linkage, private reflective fields) are
  //    stripped on copy. We pull public ones for the explore feed +
  //    the specific sample debate id even if it's not public, because
  //    the hero on /journal/debate hard-codes that one.
  console.log(`\n4/4  Fetching ${RECENT_DEBATE_COUNT} most-recent public debates + sample (${SAMPLE_DEBATE_ID})...`);
  const { data: publicDebates, error: pubErr } = await prod
    .from('debates')
    .select('*')
    .eq('is_public', true)
    .order('created_at', { ascending: false })
    .limit(RECENT_DEBATE_COUNT);
  if (pubErr) throw pubErr;
  console.log(`      got ${publicDebates.length} public debates`);

  // Sample debate — fetched separately so we still get it even if it's
  // not public. De-duplicated against the public list below.
  const { data: sampleRows, error: sampleErr } = await prod
    .from('debates')
    .select('*')
    .eq('id', SAMPLE_DEBATE_ID);
  if (sampleErr) throw sampleErr;
  if (sampleRows.length === 0) {
    console.warn(`      WARNING: sample debate ${SAMPLE_DEBATE_ID} not found in prod`);
  } else {
    console.log(`      got sample debate "${sampleRows[0].topic.slice(0, 60)}..."`);
  }

  // Merge + dedupe by id, then sanitise.
  const seenIds = new Set();
  const allDebates = [];
  for (const row of [...publicDebates, ...sampleRows]) {
    if (seenIds.has(row.id)) continue;
    seenIds.add(row.id);
    allDebates.push(sanitiseDebate(row));
  }

  console.log(`      upserting ${allDebates.length} debates into dev...`);
  await insertInBatches('debates', allDebates);

  console.log('\nDone.');
  console.log(`  sources: ${sources.length}`);
  console.log(`  threads: ${threads.length}`);
  console.log(`  items:   ${allItems.length}`);
  console.log(`  debates: ${allDebates.length}`);
}

main().catch(err => {
  console.error('\nSEED FAILED:', err.message || err);
  process.exit(1);
});
