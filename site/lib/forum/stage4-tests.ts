// ============================================================================
// dAIly Forum — Stage 4 unit tests
// ============================================================================
// Direct tests of the pure functions in topic-selection.ts and
// moderator-selection.ts. Run with:
//
//   cd site && npx tsx lib/forum/stage4-tests.ts
//
// Covers corner cases that don't reliably fire in the live E2E tests:
// - Acting moderator tier walks (best case, mid tier, last-resort tier)
// - Moderator tier_skipped (walking over higher-conflict queue entries)
// - Moderator fallback (all tiers exhausted)
// - Region softcap activation
// - Runoff resolution edge cases (urgency clear, urgency tied, both tied)
//
// No DB, no LLM calls — synthetic broadcasts and rotation queues only.
// Exits with code 1 on any failure.
// ============================================================================

import { strict as assert } from 'node:assert';
import {
  scoreVotesTop3,
  detectTie,
  resolveRunoff,
  type RunoffResult,
} from './topic-selection';
import {
  selectActingModerator,
  selectModerator,
  type RotationEntry,
} from './moderator-selection';
import type { BroadcastResult, ModelBroadcastResponse } from './broadcast';
import type { PoolModel } from './model-pool';

// --- Test harness ---

let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}`);
    console.log(`    ${msg.split('\n').join('\n    ')}`);
  }
}

function group(label: string, fn: () => void): void {
  console.log();
  console.log(label);
  fn();
}

// --- Synthetic data builders ---

function fakeModel(id: string, region: 'US' | 'China' | 'EU' = 'US'): PoolModel {
  return {
    id,
    provider: id,
    family: id,
    displayName: id,
    modelId: id,
    region,
    apiType: 'anthropic',
    apiKeyEnv: 'FAKE',
    dateAdded: '2026-01-01',
    active: true,
  };
}

function fakeQueueEntry(id: string, region: 'US' | 'China' | 'EU' = 'US'): RotationEntry {
  return {
    model: fakeModel(id, region),
    lastModeratedAt: null,
    totalSessions: 0,
  };
}

function fakeResponse(
  modelId: string,
  votes: Array<{ threadId: string; rank: number }>,
  conflicts: Array<{ threadId: string; conflictScore: number }> = [],
): ModelBroadcastResponse {
  return {
    modelId,
    modelName: modelId,
    provider: modelId,
    region: 'US',
    votes: votes.map(v => ({ ...v, voteReason: 'test' })),
    conflicts: conflicts.map(c => ({ ...c, conflictReason: 'test' })),
    stances: [],
  };
}

function fakeBroadcast(responses: ModelBroadcastResponse[]): BroadcastResult {
  return { responses, skippedModels: [], errors: [] };
}

function fakeRunoff(
  tiedTopicIds: string[],
  picks: Array<{ modelId: string; pick: string | null; urgency: Record<string, number> }>,
): RunoffResult {
  return {
    tiedTopicIds,
    picks: picks.map(p => ({
      modelId: p.modelId,
      modelName: p.modelId,
      pick: p.pick,
      urgency: p.urgency,
    })),
    errors: [],
  };
}

// ============================================================================
// topic-selection.ts tests
// ============================================================================

group('scoreVotesTop3', () => {
  test('basic 3/2/1 scoring across three models', () => {
    const broadcast = [
      fakeResponse('m1', [{ threadId: 'a', rank: 1 }, { threadId: 'b', rank: 2 }, { threadId: 'c', rank: 3 }]),
      fakeResponse('m2', [{ threadId: 'b', rank: 1 }, { threadId: 'a', rank: 2 }]),
      fakeResponse('m3', [{ threadId: 'a', rank: 1 }, { threadId: 'c', rank: 2 }]),
    ];
    const scores = scoreVotesTop3(broadcast);
    // a: 3 (m1) + 2 (m2) + 3 (m3) = 8
    // b: 2 (m1) + 3 (m2) = 5
    // c: 1 (m1) + 2 (m3) = 3
    const byId = Object.fromEntries(scores.map(s => [s.threadId, s.score]));
    assert.equal(byId.a, 8);
    assert.equal(byId.b, 5);
    assert.equal(byId.c, 3);
    assert.equal(scores[0].threadId, 'a'); // sorted descending
  });

  test('ranks below 3 score 0 points', () => {
    const broadcast = [
      fakeResponse('m1', [
        { threadId: 'a', rank: 1 },
        { threadId: 'b', rank: 2 },
        { threadId: 'c', rank: 3 },
        { threadId: 'd', rank: 4 },
        { threadId: 'e', rank: 5 },
      ]),
    ];
    const scores = scoreVotesTop3(broadcast);
    const byId = Object.fromEntries(scores.map(s => [s.threadId, s.score]));
    assert.equal(byId.d, undefined); // not in scores at all (0 points)
    assert.equal(byId.e, undefined);
  });

  test('errored responses are skipped', () => {
    const broadcast: ModelBroadcastResponse[] = [
      fakeResponse('m1', [{ threadId: 'a', rank: 1 }]),
      { ...fakeResponse('m2', [{ threadId: 'a', rank: 1 }]), error: 'API failed' },
    ];
    const scores = scoreVotesTop3(broadcast);
    assert.equal(scores[0].score, 3); // only m1 contributed
    assert.equal(scores[0].voterCount, 1);
  });
});

group('detectTie', () => {
  test('clear winner above margin', () => {
    const scores = scoreVotesTop3([
      fakeResponse('m1', [{ threadId: 'a', rank: 1 }, { threadId: 'b', rank: 2 }]),
      fakeResponse('m2', [{ threadId: 'a', rank: 1 }, { threadId: 'b', rank: 2 }]),
      fakeResponse('m3', [{ threadId: 'a', rank: 1 }, { threadId: 'b', rank: 2 }]),
    ]);
    // a=9, b=6, margin = 33%
    const result = detectTie(scores);
    assert.equal(result.winner, 'a');
    assert.equal(result.tiedTopicIds.length, 1);
    assert.ok(result.marginToSecondPct! > 10);
  });

  test('exact tie produces tied set', () => {
    const scores = scoreVotesTop3([
      fakeResponse('m1', [{ threadId: 'a', rank: 1 }, { threadId: 'b', rank: 2 }]),
      fakeResponse('m2', [{ threadId: 'b', rank: 1 }, { threadId: 'a', rank: 2 }]),
    ]);
    // a=5, b=5
    const result = detectTie(scores);
    assert.equal(result.winner, null);
    assert.equal(result.tiedTopicIds.length, 2);
    assert.equal(result.marginToSecondPct, 0);
  });

  test('within margin (5%) treated as tied', () => {
    // Construct synthetic scores manually since we want a 5% margin
    // which is hard to produce via top-3 cutoff with small counts
    const scores = [
      { threadId: 'a', score: 100, voterCount: 10, contributions: [] },
      { threadId: 'b', score: 96, voterCount: 10, contributions: [] }, // 4% gap
      { threadId: 'c', score: 70, voterCount: 7, contributions: [] },
    ];
    const result = detectTie(scores, 10);
    assert.equal(result.winner, null);
    assert.deepEqual(result.tiedTopicIds.sort(), ['a', 'b']);
  });

  test('single topic is trivially the winner', () => {
    const result = detectTie([{ threadId: 'a', score: 5, voterCount: 1, contributions: [] }]);
    assert.equal(result.winner, 'a');
  });

  test('empty scores produces null winner', () => {
    const result = detectTie([]);
    assert.equal(result.winner, null);
    assert.equal(result.tiedTopicIds.length, 0);
  });
});

group('resolveRunoff', () => {
  test('urgency clear winner (25% margin) → urgency wins, picks ignored', () => {
    // 3 topics, all picked equally, but a has dominant urgency
    const runoff = fakeRunoff(['a', 'b', 'c'], [
      { modelId: 'm1', pick: 'b', urgency: { a: 10, b: 5, c: 5 } },
      { modelId: 'm2', pick: 'b', urgency: { a: 10, b: 5, c: 5 } },
      { modelId: 'm3', pick: 'b', urgency: { a: 10, b: 5, c: 5 } },
    ]);
    // Urgency: a=30, b=15, c=15. Margin = 50%.
    // Picks: b=3, a=0, c=0
    const result = resolveRunoff(runoff);
    assert.equal(result.winner, 'a', 'urgency-first should pick a even though all picks went to b');
    assert.equal(result.resolvedBy, 'urgency');
  });

  test('urgency margin within 5% → falls to picks', () => {
    // The original 27/26/20 case from real test data
    const runoff = fakeRunoff(['scheming', 'prompt_inj', 'joint'], [
      { modelId: 'm1', pick: 'scheming', urgency: { scheming: 9, prompt_inj: 7, joint: 6 } },
      { modelId: 'm2', pick: 'prompt_inj', urgency: { scheming: 9, prompt_inj: 10, joint: 7 } },
      { modelId: 'm3', pick: 'prompt_inj', urgency: { scheming: 9, prompt_inj: 10, joint: 7 } },
    ]);
    // Urgency: scheming=27, prompt_inj=27, joint=20. Margin = 0% → tied
    // Picks: prompt_inj=2, scheming=1
    // Within urgency-tied set [scheming, prompt_inj], picks favor prompt_inj
    const result = resolveRunoff(runoff);
    assert.equal(result.winner, 'prompt_inj', 'picks should resolve when urgency is tied within margin');
    assert.equal(result.resolvedBy, 'picks');
  });

  test('urgency narrow gap (3.7%) within 5% margin → falls to picks', () => {
    // Construct exactly 27 vs 26
    const runoff = fakeRunoff(['a', 'b'], [
      { modelId: 'm1', pick: 'b', urgency: { a: 9, b: 6 } },
      { modelId: 'm2', pick: 'b', urgency: { a: 9, b: 10 } },
      { modelId: 'm3', pick: 'b', urgency: { a: 9, b: 10 } },
    ]);
    // Urgency: a=27, b=26. Margin = 3.7% < 5%
    // Picks: b=3
    const result = resolveRunoff(runoff);
    assert.equal(result.winner, 'b', 'picks should win when urgency is barely above margin');
    assert.equal(result.resolvedBy, 'picks');
  });

  test('urgency tied AND picks tied → still tied (acting mod path)', () => {
    const runoff = fakeRunoff(['a', 'b'], [
      { modelId: 'm1', pick: 'a', urgency: { a: 8, b: 8 } },
      { modelId: 'm2', pick: 'b', urgency: { a: 8, b: 8 } },
    ]);
    // Urgency: a=16, b=16. Tied.
    // Picks: a=1, b=1. Tied.
    const result = resolveRunoff(runoff);
    assert.equal(result.winner, null);
    assert.equal(result.resolvedBy, null);
    assert.deepEqual(result.stillTiedTopicIds.sort(), ['a', 'b']);
  });

  test('only one tied topic → trivially resolved by urgency', () => {
    const runoff = fakeRunoff(['a'], [
      { modelId: 'm1', pick: 'a', urgency: { a: 5 } },
    ]);
    const result = resolveRunoff(runoff);
    assert.equal(result.winner, 'a');
    assert.equal(result.resolvedBy, 'urgency');
  });
});

// ============================================================================
// moderator-selection.ts tests
// ============================================================================

group('selectActingModerator', () => {
  test('tier 1 — clean referee with <30 max conflict', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
      fakeQueueEntry('gemini', 'US'),
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'a', conflictScore: 20 }, { threadId: 'b', conflictScore: 25 }]),
      fakeResponse('gpt5', [], [{ threadId: 'a', conflictScore: 80 }, { threadId: 'b', conflictScore: 90 }]),
      fakeResponse('gemini', [], [{ threadId: 'a', conflictScore: 60 }, { threadId: 'b', conflictScore: 70 }]),
    ]);
    const result = selectActingModerator(['a', 'b'], broadcast, queue);
    assert.equal(result.modelId, 'opus', 'tier 1 should pick opus (max=25)');
    assert.equal(result.tier, 1);
    assert.equal(result.maxConflict, 25);
  });

  test('tier 3 — best available is in 50-69 range', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
      fakeQueueEntry('gemini', 'US'),
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'a', conflictScore: 80 }, { threadId: 'b', conflictScore: 85 }]),
      fakeResponse('gpt5', [], [{ threadId: 'a', conflictScore: 60 }, { threadId: 'b', conflictScore: 65 }]),
      fakeResponse('gemini', [], [{ threadId: 'a', conflictScore: 90 }, { threadId: 'b', conflictScore: 95 }]),
    ]);
    const result = selectActingModerator(['a', 'b'], broadcast, queue);
    assert.equal(result.modelId, 'gpt5', 'tier 3 should pick gpt5 (max=65)');
    assert.equal(result.tier, 3);
    assert.equal(result.maxConflict, 65);
  });

  test('tier 6 (no check) — everyone above 90, last resort', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'a', conflictScore: 95 }, { threadId: 'b', conflictScore: 99 }]),
      fakeResponse('gpt5', [], [{ threadId: 'a', conflictScore: 100 }, { threadId: 'b', conflictScore: 100 }]),
    ]);
    const result = selectActingModerator(['a', 'b'], broadcast, queue);
    assert.equal(result.modelId, 'opus', 'tier 6 should pick first in queue (opus)');
    assert.equal(result.tier, 6);
    assert.equal(result.tierThreshold, null);
  });

  test('rotation order honored within tier', () => {
    // Opus has higher conflict than gemini at tier 1 thresholds, but
    // both are eligible at tier 2. Opus is first in queue.
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gemini', 'US'),
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'a', conflictScore: 40 }, { threadId: 'b', conflictScore: 45 }]),
      fakeResponse('gemini', [], [{ threadId: 'a', conflictScore: 35 }, { threadId: 'b', conflictScore: 38 }]),
    ]);
    const result = selectActingModerator(['a', 'b'], broadcast, queue);
    // Tier 1 (<30): nobody
    // Tier 2 (<50): opus first (max=45 < 50), eligible. Picked.
    assert.equal(result.modelId, 'opus', 'rotation order picks opus at tier 2 even though gemini has lower conflict');
    assert.equal(result.tier, 2);
  });
});

group('selectModerator', () => {
  test('tier_clean — first in queue passes tier 1', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'topic', conflictScore: 10 }]),
      fakeResponse('gpt5', [], [{ threadId: 'topic', conflictScore: 5 }]),
    ]);
    const result = selectModerator('topic', broadcast, queue, []);
    assert.equal(result.modelId, 'opus', 'first in queue with tier-1 conflict wins');
    assert.equal(result.tier, 1);
    assert.equal(result.method, 'tier_clean');
    assert.equal(result.skipped.length, 0);
  });

  test('tier preference — clean tier 1 model beats compromised tier 3 model', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),     // queue 0, conflict 60 → tier 3 only
      fakeQueueEntry('gpt5', 'US'),     // queue 1, conflict 20 → tier 1
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'topic', conflictScore: 60 }]),
      fakeResponse('gpt5', [], [{ threadId: 'topic', conflictScore: 20 }]),
    ]);
    const result = selectModerator('topic', broadcast, queue, []);
    assert.equal(result.modelId, 'gpt5', 'tier 1 (gpt5 at 20) should beat tier 3 (opus at 60)');
    assert.equal(result.tier, 1);
    assert.equal(result.method, 'tier_skipped', 'opus was walked over');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].modelId, 'opus');
    assert.equal(result.skipped[0].conflictScore, 60);
  });

  test('tier_skipped — walks past higher-conflict queue entry within same tier', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),     // queue 0, conflict 80 → tier 4
      fakeQueueEntry('gpt5', 'US'),     // queue 1, conflict 45 → tier 2
      fakeQueueEntry('gemini', 'US'),   // queue 2, conflict 25 → tier 1
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'topic', conflictScore: 80 }]),
      fakeResponse('gpt5', [], [{ threadId: 'topic', conflictScore: 45 }]),
      fakeResponse('gemini', [], [{ threadId: 'topic', conflictScore: 25 }]),
    ]);
    const result = selectModerator('topic', broadcast, queue, []);
    // Tier 1 (<30): gemini eligible, opus and gpt5 walked over
    assert.equal(result.modelId, 'gemini');
    assert.equal(result.tier, 1);
    assert.equal(result.method, 'tier_skipped');
    // Both opus and gpt5 should be in skipped (their conflicts are higher than gemini's 25)
    assert.equal(result.skipped.length, 2);
    assert.deepEqual(result.skipped.map(s => s.modelId).sort(), ['gpt5', 'opus']);
  });

  test('fallback — all tiers exhausted, rotation decides within 10pt window', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
      fakeQueueEntry('gemini', 'US'),
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'topic', conflictScore: 95 }]),
      fakeResponse('gpt5', [], [{ threadId: 'topic', conflictScore: 92 }]),
      fakeResponse('gemini', [], [{ threadId: 'topic', conflictScore: 99 }]),
    ]);
    const result = selectModerator('topic', broadcast, queue, []);
    // All 3 are in fallback (≥90). minConflict=92, window=102, so all
    // 3 are "tied" → rotation order breaks → opus (queue 0) wins.
    // NOTE: in practice the 10-point fallback window will ALWAYS span
    // the entire fallback range (90-100), so rotation effectively
    // always decides in this branch. The window logic is preserved
    // for safety in case tier thresholds change.
    assert.equal(result.method, 'fallback_least_conflicted');
    assert.equal(result.tier, null);
    assert.equal(result.modelId, 'opus', 'rotation decides because all models are within the 10pt window');
    assert.equal(result.skipped.length, 2);
  });

  test('fallback 10-point window — rotation order breaks tie', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),    // queue 0
      fakeQueueEntry('gpt5', 'US'),    // queue 1
      fakeQueueEntry('gemini', 'US'),  // queue 2
    ];
    const broadcast = fakeBroadcast([
      // All within 10 points of each other (95, 92, 99)
      fakeResponse('opus', [], [{ threadId: 'topic', conflictScore: 95 }]),
      fakeResponse('gpt5', [], [{ threadId: 'topic', conflictScore: 92 }]),
      fakeResponse('gemini', [], [{ threadId: 'topic', conflictScore: 99 }]),
    ]);
    const result = selectModerator('topic', broadcast, queue, []);
    // min = 92 (gpt5), tied window = up to 102, so all 3 are in tied set
    // rotation order earliest = opus (queue 0)
    assert.equal(result.modelId, 'opus', 'rotation order should break the 10-point tie');
    assert.equal(result.method, 'fallback_least_conflicted');
  });

  test('region softcap — swaps to different region after 2 same-region in a row', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),     // queue 0, US, would extend streak
      fakeQueueEntry('gpt5', 'US'),     // queue 1, US, also would extend
      fakeQueueEntry('deepseek', 'China'), // queue 2, China, breaks streak
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'topic', conflictScore: 5 }]),
      fakeResponse('gpt5', [], [{ threadId: 'topic', conflictScore: 5 }]),
      fakeResponse('deepseek', [], [{ threadId: 'topic', conflictScore: 5 }]),
    ]);
    const recentRegions = ['US', 'US']; // last 2 moderators were US
    const result = selectModerator('topic', broadcast, queue, recentRegions);
    assert.equal(result.modelId, 'deepseek', 'softcap should swap to deepseek (China) instead of opus (US)');
    assert.equal(result.regionSoftcapApplied, true);
    assert.equal(result.tier, 1);
  });

  test('region softcap does NOT activate with insufficient history', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('deepseek', 'China'),
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'topic', conflictScore: 5 }]),
      fakeResponse('deepseek', [], [{ threadId: 'topic', conflictScore: 5 }]),
    ]);
    // Only one prior moderator — softcap needs 2
    const result = selectModerator('topic', broadcast, queue, ['US']);
    assert.equal(result.modelId, 'opus', 'opus picked normally with insufficient region history');
    assert.equal(result.regionSoftcapApplied, false);
  });

  test('region softcap does NOT override conflict rule', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),       // clean (5) but US extends streak
      fakeQueueEntry('deepseek', 'China'), // conflicted (95) — would break streak but ineligible at tier 1
    ];
    const broadcast = fakeBroadcast([
      fakeResponse('opus', [], [{ threadId: 'topic', conflictScore: 5 }]),
      fakeResponse('deepseek', [], [{ threadId: 'topic', conflictScore: 95 }]),
    ]);
    const result = selectModerator('topic', broadcast, queue, ['US', 'US']);
    // At tier 1, deepseek not eligible (95 ≥ 30). Only opus passes.
    // Softcap can't swap because no other region candidate is eligible.
    assert.equal(result.modelId, 'opus', 'opus picked because deepseek fails conflict at tier 1');
    assert.equal(result.regionSoftcapApplied, false);
  });
});

// --- Run + report ---

console.log();
console.log('========================================');
console.log(`Total: ${passed + failed} | Passed: ${passed} | Failed: ${failed}`);
console.log('========================================');

if (failed > 0) {
  console.log();
  console.log('Failures:');
  for (const f of failures) console.log('  -', f);
  process.exit(1);
}

process.exit(0);
