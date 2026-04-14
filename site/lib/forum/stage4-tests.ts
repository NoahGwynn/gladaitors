// ============================================================================
// dAIly Forum — Stage 4 unit tests
// ============================================================================
// Direct tests of the pure functions in topic-selection.ts and
// moderator-selection.ts. Run with:
//
//   cd site && npx tsx lib/forum/stage4-tests.ts
//
// Covers:
// - Vote scoring (top-3 cutoff)
// - Tie detection and runoff resolution
// - Moderator selection from a FOCUSED broadcast result:
//     - tier_clean / tier_skipped / region softcap
//     - self-veto hard filter
//     - drop-to-unmoderated outcome
// - Acting moderator selection (pure rotation after the refactor)
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
  type ModeratorSelectionOutcome,
} from './moderator-selection';
import type { ModelBroadcastResponse } from './broadcast';
import type { FocusedBroadcastResult, FocusedBroadcastResponse } from './focused-broadcast';
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

/** Build a fake ModelBroadcastResponse for vote-scoring tests. The
 *  initial broadcast is votes-only now. */
function fakeResponse(
  modelId: string,
  votes: Array<{ threadId: string; rank: number }>,
): ModelBroadcastResponse {
  return {
    modelId,
    modelName: modelId,
    provider: modelId,
    region: 'US',
    votes: votes.map(v => ({ ...v, voteReason: 'test' })),
  };
}

/** Build a fake FocusedBroadcastResponse for moderator-selection tests. */
function fakeFocusedResponse(
  modelId: string,
  conflictScore: number,
  opts: { unfit?: boolean; unfitReason?: string; error?: string } = {},
): FocusedBroadcastResponse {
  return {
    modelId,
    modelName: modelId,
    provider: modelId,
    region: 'US',
    conflictScore,
    conflictReason: 'test',
    unfitToModerate: opts.unfit ?? false,
    unfitReason: opts.unfitReason ?? '',
    stance: 'test stance',
    error: opts.error,
  };
}

function fakeFocused(responses: FocusedBroadcastResponse[]): FocusedBroadcastResult {
  return {
    topicId: 'topic',
    topicTitle: 'test topic',
    responses,
    skippedModels: [],
    errors: [],
  };
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

function expectModerated(outcome: ModeratorSelectionOutcome): Extract<ModeratorSelectionOutcome, { kind: 'moderated' }> {
  if (outcome.kind !== 'moderated') {
    throw new Error(`expected moderated outcome, got ${outcome.kind} (${JSON.stringify(outcome)})`);
  }
  return outcome;
}

function expectUnmoderated(outcome: ModeratorSelectionOutcome): Extract<ModeratorSelectionOutcome, { kind: 'unmoderated' }> {
  if (outcome.kind !== 'unmoderated') {
    throw new Error(`expected unmoderated outcome, got ${outcome.kind}`);
  }
  return outcome;
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
    const byId = Object.fromEntries(scores.map(s => [s.threadId, s.score]));
    assert.equal(byId.a, 8);
    assert.equal(byId.b, 5);
    assert.equal(byId.c, 3);
    assert.equal(scores[0].threadId, 'a');
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
    assert.equal(byId.d, undefined);
    assert.equal(byId.e, undefined);
  });

  test('errored responses are skipped', () => {
    const broadcast: ModelBroadcastResponse[] = [
      fakeResponse('m1', [{ threadId: 'a', rank: 1 }]),
      { ...fakeResponse('m2', [{ threadId: 'a', rank: 1 }]), error: 'API failed' },
    ];
    const scores = scoreVotesTop3(broadcast);
    assert.equal(scores[0].score, 3);
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
    const result = detectTie(scores);
    assert.equal(result.winner, null);
    assert.equal(result.tiedTopicIds.length, 2);
    assert.equal(result.marginToSecondPct, 0);
  });

  test('within margin (5%) treated as tied', () => {
    const scores = [
      { threadId: 'a', score: 100, voterCount: 10, contributions: [] },
      { threadId: 'b', score: 96, voterCount: 10, contributions: [] },
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
    const runoff = fakeRunoff(['a', 'b', 'c'], [
      { modelId: 'm1', pick: 'b', urgency: { a: 10, b: 5, c: 5 } },
      { modelId: 'm2', pick: 'b', urgency: { a: 10, b: 5, c: 5 } },
      { modelId: 'm3', pick: 'b', urgency: { a: 10, b: 5, c: 5 } },
    ]);
    const result = resolveRunoff(runoff);
    assert.equal(result.winner, 'a');
    assert.equal(result.resolvedBy, 'urgency');
  });

  test('urgency margin within 5% → falls to picks', () => {
    const runoff = fakeRunoff(['scheming', 'prompt_inj', 'joint'], [
      { modelId: 'm1', pick: 'scheming', urgency: { scheming: 9, prompt_inj: 7, joint: 6 } },
      { modelId: 'm2', pick: 'prompt_inj', urgency: { scheming: 9, prompt_inj: 10, joint: 7 } },
      { modelId: 'm3', pick: 'prompt_inj', urgency: { scheming: 9, prompt_inj: 10, joint: 7 } },
    ]);
    const result = resolveRunoff(runoff);
    assert.equal(result.winner, 'prompt_inj');
    assert.equal(result.resolvedBy, 'picks');
  });

  test('urgency tied AND picks tied → still tied (acting mod path)', () => {
    const runoff = fakeRunoff(['a', 'b'], [
      { modelId: 'm1', pick: 'a', urgency: { a: 8, b: 8 } },
      { modelId: 'm2', pick: 'b', urgency: { a: 8, b: 8 } },
    ]);
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
// moderator-selection.ts tests (new shape: focused broadcast + self-veto)
// ============================================================================

group('selectActingModerator (pure rotation)', () => {
  test('first in queue wins regardless of conflict picture', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
      fakeQueueEntry('gemini', 'US'),
    ];
    const result = selectActingModerator(queue);
    assert.equal(result.modelId, 'opus');
    assert.equal(result.method, 'rotation');
  });
});

group('selectModerator', () => {
  test('tier_clean — first in queue passes tier 1', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
    ];
    const focused = fakeFocused([
      fakeFocusedResponse('opus', 10),
      fakeFocusedResponse('gpt5', 5),
    ]);
    const outcome = selectModerator(focused, queue, []);
    const result = expectModerated(outcome).result;
    assert.equal(result.modelId, 'opus');
    assert.equal(result.tier, 1);
    assert.equal(result.method, 'tier_clean');
  });

  test('tier preference — clean tier 1 model beats tier 3 model', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
    ];
    const focused = fakeFocused([
      fakeFocusedResponse('opus', 60),
      fakeFocusedResponse('gpt5', 20),
    ]);
    const result = expectModerated(selectModerator(focused, queue, [])).result;
    assert.equal(result.modelId, 'gpt5');
    assert.equal(result.tier, 1);
    assert.equal(result.method, 'tier_skipped');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0].modelId, 'opus');
    assert.equal(result.skipped[0].skipReason, 'conflict_above_threshold');
  });

  test('self-veto is a hard filter even with low conflict', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
    ];
    const focused = fakeFocused([
      fakeFocusedResponse('opus', 10, { unfit: true, unfitReason: 'co-authored the paper being discussed' }),
      fakeFocusedResponse('gpt5', 40),
    ]);
    const result = expectModerated(selectModerator(focused, queue, [])).result;
    assert.equal(result.modelId, 'gpt5', 'self-vetoed opus skipped despite cleaner conflict');
    const vetoEntry = result.skipped.find(s => s.modelId === 'opus');
    assert.ok(vetoEntry, 'opus should be in skipped');
    assert.equal(vetoEntry!.skipReason, 'self_vetoed');
    assert.equal(vetoEntry!.unfitToModerate, true);
  });

  test('drop to unmoderated — every candidate scored ≥80', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
      fakeQueueEntry('gemini', 'US'),
    ];
    const focused = fakeFocused([
      fakeFocusedResponse('opus', 85),
      fakeFocusedResponse('gpt5', 92),
      fakeFocusedResponse('gemini', 88),
    ]);
    const outcome = expectUnmoderated(selectModerator(focused, queue, []));
    assert.equal(outcome.dropReason, 'all_conflict_too_high');
    assert.equal(outcome.skipped.length, 3);
  });

  test('drop to unmoderated — every candidate self-vetoed', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
    ];
    const focused = fakeFocused([
      fakeFocusedResponse('opus', 20, { unfit: true, unfitReason: 'my lab authored this' }),
      fakeFocusedResponse('gpt5', 15, { unfit: true, unfitReason: 'my lab is the subject' }),
    ]);
    const outcome = expectUnmoderated(selectModerator(focused, queue, []));
    assert.equal(outcome.dropReason, 'all_self_vetoed');
    assert.equal(outcome.skipped.filter(s => s.skipReason === 'self_vetoed').length, 2);
  });

  test('drop to unmoderated — no valid responses at all', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
    ];
    const focused = fakeFocused([
      fakeFocusedResponse('opus', 0, { error: 'call failed' }),
    ]);
    const outcome = expectUnmoderated(selectModerator(focused, queue, []));
    assert.equal(outcome.dropReason, 'no_valid_responses');
  });

  test('region softcap — swaps to different region after 2 same-region in a row', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('gpt5', 'US'),
      fakeQueueEntry('deepseek', 'China'),
    ];
    const focused = fakeFocused([
      fakeFocusedResponse('opus', 5),
      fakeFocusedResponse('gpt5', 5),
      fakeFocusedResponse('deepseek', 5),
    ]);
    const result = expectModerated(selectModerator(focused, queue, ['US', 'US'])).result;
    assert.equal(result.modelId, 'deepseek');
    assert.equal(result.regionSoftcapApplied, true);
    assert.equal(result.tier, 1);
  });

  test('region softcap does NOT activate with insufficient history', () => {
    const queue = [
      fakeQueueEntry('opus', 'US'),
      fakeQueueEntry('deepseek', 'China'),
    ];
    const focused = fakeFocused([
      fakeFocusedResponse('opus', 5),
      fakeFocusedResponse('deepseek', 5),
    ]);
    const result = expectModerated(selectModerator(focused, queue, ['US'])).result;
    assert.equal(result.modelId, 'opus');
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
