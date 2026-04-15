// ============================================================================
// the dAIly — Moderation Check 3: Tone and Bias
// ============================================================================
// Reviews the debate output for partisan framing, loaded language,
// and asymmetric treatment of different perspectives. Not to enforce
// false balance — the dAIly IS an evidence-weighing product and
// honest disagreement is the point — but to catch language that
// signals editorial position rather than evidence-weighing.
//
// The distinction that matters:
//
//   Evidence-weighing language (OK):
//     "The benchmark numbers suggest the improvement is real but
//      modest, within the range of normal generation-to-generation
//      gains."
//     "Two of the three published evaluations found the effect;
//      one did not. The methodology of the null result is harder
//      to defend."
//
//   Partisan / loaded language (NOT OK):
//     "Obviously this is just another cash grab from a company
//      that's lost the plot."
//     "The typical pattern of big-tech overreach."
//     "As any reasonable observer would see..."
//
// The first kind reasons about the evidence. The second kind
// performs a tribal identity. The dAIly is for the first.
//
// What this check does NOT do:
//   - Enforce false balance ("must say nice things about X to offset
//     criticism")
//   - Censor legitimate critical assessment
//   - Require the debate to reach a centrist conclusion
//   - Flag strong disagreement between panelists — the whole point
//     is for them to disagree
// ============================================================================

import type { DebateSnapshot } from '../debate-runtime';
import type { CastParticipant } from '../cast-selection';
import {
  type CategoryCriteria,
  type ModerationCheckResult,
  renderDebateTranscript,
  parseFindingsResponse,
} from '../moderation-pipeline';
import { PRIMARY_SCREENER, callModerationModel } from '../moderation-pool';

export interface ToneBiasCheckInput {
  topicTitle: string;
  debateSnapshot: DebateSnapshot;
  cast: CastParticipant[];
  criteria: CategoryCriteria;
}

function buildPrompt(input: ToneBiasCheckInput): { system: string; user: string } {
  const { criteria } = input;

  const system = `You are a tone and bias screening model for the dAIly, an editorial product that publishes AI-generated debates on current events. Your job is to read the full debate transcript and flag language that signals editorial position or tribal identity rather than evidence-weighing.

THE DISTINCTION YOU'RE MAKING

Evidence-weighing language is GOOD. Loaded and partisan language is BAD. The difference:

  Evidence-weighing (do not flag):
    "The benchmark numbers suggest a meaningful improvement but within
     the range of normal generation-to-generation gains."
    "Two of three published evaluations found the effect; the one that
     didn't has methodological issues worth noting."
    "The company's stated rationale is consistent with the evidence;
     critics' alternative explanation is not yet supported by the data."

  Loaded / partisan (flag):
    "Yet another cash grab from a company that's lost the plot."
    "The typical pattern of big-tech overreach."
    "As any reasonable observer would see..."
    "The deeply flawed premise of the entire approach."
    "A transparent attempt to..."

The first set reasons about the evidence. The second set performs a tribal identity. The dAIly is an evidence-weighing product and the first is what it should sound like.

WHAT TO FLAG

  - Loaded adjectives that bake in a conclusion rather than supporting one ("flawed", "cynical", "transparent", "naked")
  - Dismissive framing of the "other side" without engaging its arguments
  - Tribal signalling language ("as we all know", "the reasonable position")
  - Asymmetric treatment where one side of an argument gets softer language than the other for the same kind of behaviour
  - Mood-music language that signals "and this is bad" without saying why
  - Performative outrage, snark, or sarcasm
  - Unfalsifiable characterisations ("bad-faith actors", "not serious people")

WHAT NOT TO FLAG

  - Strong disagreement between panelists (the whole point is for them to disagree)
  - Confident claims backed by cited evidence
  - Critical assessment that identifies specific flaws in reasoning
  - Reported speech or quotes (even if the quoted statement is loaded — that's attribution, not the lab's voice)
  - Moderator counter-questions that press a panelist's weak argument
  - Plain language characterisations where the evidence clearly supports them
  - Clear preference or conclusion expressed with appropriate hedging

The test: if you swapped "bad position X" for "good position Y" in the debate, would the overall tone still feel appropriate for an evidence-weighing publication? Or would the loaded language suddenly look out of place? If the latter, the language was loaded.

CATEGORY CONTEXT

This is a ${criteria.label} category debate. Subject: ${criteria.subject}

Pay particular attention to: ${criteria.emphases.toneBias}

SEVERITY

  - critical — the framing is loaded enough that an attentive reader would interpret it as the lab taking sides rather than weighing evidence. Blocks publication.
  - minor — borderline word choice that could be softened. Logged but doesn't block.

OUTPUT

Respond with JSON only. Your job is to flag real bias, not to find something wrong with every debate. Strong, confident evidence-weighing is exactly what this product should sound like. Clean output is the correct answer when the content is genuinely evidence-weighing.

{
  "findings": [
    {
      "severity": "critical" | "minor",
      "location": "<turn reference like 'T04' or a short quoted snippet>",
      "issue": "<one sentence: what's loaded or partisan about the phrasing>",
      "rationale": "<why this reads as editorial position rather than evidence-weighing, and what a reader who disagreed with the conclusion would think on reading it>",
      "suggestion": "<optional: an evidence-weighing rephrase that keeps the substance>"
    }
  ]
}`;

  const transcript = renderDebateTranscript(input.debateSnapshot, input.cast);

  const user = `TOPIC: ${input.topicTitle}

CATEGORY: ${criteria.label}

DEBATE TRANSCRIPT:

${transcript}

Run the tone and bias check. Return findings in the JSON shape above.`;

  return { system, user };
}

export async function runToneBiasCheck(
  input: ToneBiasCheckInput,
): Promise<ModerationCheckResult> {
  const startedAt = Date.now();
  console.log(`[MODERATION] Running tone/bias check...`);

  const { system, user } = buildPrompt(input);

  try {
    const raw = await callModerationModel(PRIMARY_SCREENER, system, user, 8000);
    const parsed = parseFindingsResponse(raw, 'tone_bias');

    const durationSeconds = (Date.now() - startedAt) / 1000;

    if ('error' in parsed) {
      console.error(`[MODERATION] Tone/bias check parse failed: ${parsed.error}`);
      return {
        check: 'tone_bias',
        durationSeconds,
        ok: false,
        findings: [],
        error: `Parse failed: ${parsed.error}`,
      };
    }

    const criticalCount = parsed.findings.filter(f => f.severity === 'critical').length;
    const minorCount = parsed.findings.filter(f => f.severity === 'minor').length;
    console.log(`[MODERATION] Tone/bias check done in ${durationSeconds.toFixed(1)}s: ${criticalCount} critical, ${minorCount} minor`);

    return {
      check: 'tone_bias',
      durationSeconds,
      ok: true,
      findings: parsed.findings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    const durationSeconds = (Date.now() - startedAt) / 1000;
    console.error(`[MODERATION] Tone/bias check failed: ${msg}`);
    return {
      check: 'tone_bias',
      durationSeconds,
      ok: false,
      findings: [],
      error: msg,
    };
  }
}
