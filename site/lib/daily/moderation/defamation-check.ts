// ============================================================================
// the dAIly — Moderation Check 1: Defamation
// ============================================================================
// Reads the full debate output and flags phrasings that could
// constitute a defamatory claim about a named individual or
// organisation. Looking specifically for:
//
//   - Claims that someone is lying
//   - Claims of motive or intent (deliberate deception, cover-up)
//   - Claims of criminal conduct
//   - Claims that contradict an official position presented as fact
//     rather than opinion
//
// What this check does NOT flag:
//   - Honest critical assessment of public figures' stated positions
//   - Evidence-backed disagreement with official claims
//   - Quoted controversial statements attributed correctly to their
//     source (these are reported speech, not the lab's voice)
//   - Hedged language about intent ("may indicate", "raises questions
//     about", "appears inconsistent with")
//
// The line we care about is: is the lab making a defamatory claim in
// its own voice? Critical commentary that's clearly framed as opinion
// or evidence-weighing is fine. Statements of fact about someone
// being dishonest or acting criminally are not.
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

export interface DefamationCheckInput {
  topicTitle: string;
  debateSnapshot: DebateSnapshot;
  cast: CastParticipant[];
  criteria: CategoryCriteria;
}

function buildPrompt(input: DefamationCheckInput): { system: string; user: string } {
  const { criteria } = input;

  const system = `You are a defamation screening model for the dAIly, an editorial product that publishes daily AI-generated debates on current events. Your job is to read the full debate output and flag phrasings that could constitute a defamatory claim about a named individual or organisation under UK defamation law (the lab is UK-based).

WHAT TO FLAG

Look specifically for:
  - Claims that a named individual or organisation is lying, deceiving, or acting dishonestly — stated as fact rather than as evidence-based inference
  - Claims of motive or intent attributed to a specific party (e.g. "they deliberately suppressed", "they concealed", "they intended to mislead") without explicit source grounding
  - Claims of criminal conduct (fraud, corruption, theft, abuse) against a named person or organisation
  - Statements that contradict an official position presented as fact rather than as disagreement
  - Attribution of failures, bad outcomes, or misconduct to individual named employees

WHAT NOT TO FLAG

The dAIly is an editorial publication and legitimate critical commentary is the product, not a risk. Do NOT flag:
  - Honest critical assessment of public figures' stated positions
  - Evidence-backed disagreement with official claims where the disagreement is clearly framed
  - Quoted controversial statements attributed correctly to their source (reported speech)
  - Hedged language about intent ("may indicate", "raises questions about", "appears inconsistent with")
  - Legitimate criticism of corporate strategy, product decisions, or public policy
  - Discussion of publicly documented controversies where the debate reflects what's already on record

The line: is the lab making a defamatory claim in its own voice, stated as fact? If the debate is weighing evidence and the framing is clear, it's fine. If the debate is asserting someone committed a wrong, it's not.

CATEGORY CONTEXT

This is a ${criteria.label} category debate. Subject: ${criteria.subject}

Pay particular attention to: ${criteria.emphases.defamation}

${criteria.hardProhibitions.length > 0 ? `HARD PROHIBITIONS — any instance is an automatic critical finding:\n${criteria.hardProhibitions.map(p => `  - ${p}`).join('\n')}` : ''}

SEVERITY

Classify each finding as:
  - critical — would block publication. A reasonable reader would interpret this as a defamatory factual claim in the lab's own voice. The lab could not defend this if challenged.
  - minor — worth logging but does not block. Could be reworded for safety but is borderline / the framing is mostly acceptable.

OUTPUT

Respond with JSON only. If there are no findings, return an empty findings array. Do not fabricate findings to seem thorough — the critical rule of the dAIly moderation pipeline is that skipping a day is always acceptable, and so is publishing a clean day. Your job is to flag real defamation risks, not to find something wrong.

{
  "findings": [
    {
      "severity": "critical" | "minor",
      "location": "<turn reference like 'T04' or a short quoted snippet>",
      "issue": "<one sentence description of the defamatory phrasing>",
      "rationale": "<why this reads as a defamatory claim and would be hard to defend>",
      "suggestion": "<optional rephrase that would keep the substance but remove the risk>"
    }
  ]
}`;

  const transcript = renderDebateTranscript(input.debateSnapshot, input.cast);

  const user = `TOPIC: ${input.topicTitle}

CATEGORY: ${criteria.label}

DEBATE TRANSCRIPT:

${transcript}

Run the defamation check. Return findings in the JSON shape above.`;

  return { system, user };
}

export async function runDefamationCheck(
  input: DefamationCheckInput,
): Promise<ModerationCheckResult> {
  const startedAt = Date.now();
  console.log(`[MODERATION] Running defamation check...`);

  const { system, user } = buildPrompt(input);

  try {
    const raw = await callModerationModel(PRIMARY_SCREENER, system, user, 8000);
    const parsed = parseFindingsResponse(raw, 'defamation');

    const durationSeconds = (Date.now() - startedAt) / 1000;

    if ('error' in parsed) {
      console.error(`[MODERATION] Defamation check parse failed: ${parsed.error}`);
      return {
        check: 'defamation',
        durationSeconds,
        ok: false,
        findings: [],
        error: `Parse failed: ${parsed.error}`,
      };
    }

    const criticalCount = parsed.findings.filter(f => f.severity === 'critical').length;
    const minorCount = parsed.findings.filter(f => f.severity === 'minor').length;
    console.log(`[MODERATION] Defamation check done in ${durationSeconds.toFixed(1)}s: ${criticalCount} critical, ${minorCount} minor`);

    return {
      check: 'defamation',
      durationSeconds,
      ok: true,
      findings: parsed.findings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    const durationSeconds = (Date.now() - startedAt) / 1000;
    console.error(`[MODERATION] Defamation check failed: ${msg}`);
    return {
      check: 'defamation',
      durationSeconds,
      ok: false,
      findings: [],
      error: msg,
    };
  }
}
