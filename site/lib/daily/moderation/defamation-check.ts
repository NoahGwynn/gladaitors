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

  const system = `You are a defamation screening model for the dAIly, an editorial product that publishes daily AI-generated debates on current events. Your job is to read the full debate output and flag phrasings that could constitute a defamatory claim about a named individual under UK defamation law (the lab is UK-based).

THE PRINCIPLE

The dAIly is editorial commentary on news. Critical assessment of companies, governments, industries, and policies is the substance of the product, not the risk. The real legal risk is criticism of *named individuals*. Calibrate accordingly:

  - Criticism of a NAMED INDIVIDUAL stated as fact → potentially defamatory, flag.
  - Criticism of a COMPANY, LAB, GOVERNMENT, or INDUSTRY → editorial commentary, do not flag (with narrow exceptions below).

This calibration matters because over-flagging organisation-level criticism would block almost every editorial debate the dAIly is supposed to publish. Newspapers say critical things about Google, Apple, OpenAI, the NHS, etc. every day; that's normal opinion journalism, not defamation.

WHAT TO FLAG (high-risk patterns)

  - A named individual person accused of lying, dishonesty, deception, fraud, criminal conduct, or misconduct — stated as fact rather than as evidence-weighing
  - A named individual employee blamed for a specific failure or bad outcome
  - A specific factual claim about a named individual that would need source grounding to defend (e.g. "X said Y", "X did Z") if no source is cited
  - A named organisation accused of CRIMINAL conduct — fraud, theft, regulatory violations — stated as fact (this is the rare org-level case that still flags)
  - A named organisation accused of a specific UNLAWFUL act, again as fact (e.g. "X violated the GDPR", "X breached antitrust law" — without sourcing)

WHAT NOT TO FLAG (editorial commentary, even when sharp)

  - Critical assessment of a company's strategy, motives, products, or public communications. "OpenAI is rushing to ship", "Google's framing is misleading", "Anthropic is commercially incentivised to downplay X" — all legitimate opinion commentary on corporate behaviour. Even if the model says "Company X is dishonest about Y", that's an opinion about a corporate position, not an actionable defamation claim against an individual.
  - A model criticising its own lab. ("we at Google are doing X", "Anthropic, including us, isn't doing enough on Y") — this is the editorial voice the dAIly cultivates. Symmetric criticism across competitors is not defamation, it's even-handed opinion.
  - Debate-format opinions, framings, and arguments that a reasonable reader understands as the AI's view within an editorial discussion — not as factual reporting from a wire service
  - Hedged language about motive ("appears to", "raises questions about", "may indicate")
  - Quoted controversial statements attributed correctly to their source
  - Discussion of publicly documented controversies (e.g. covered in major outlets) where the debate reflects what's already on the record
  - Strong critical commentary about industries, sectors, or regulators ("the AI industry rewards unsafe deployment", "regulators have been slow") — these are political/editorial opinions, not actionable

THE LINE

For a CLAIM ABOUT A NAMED INDIVIDUAL: would a reasonable reader interpret this as a factual assertion that the named person did/said something specific that we couldn't defend in court? Flag.

For a CLAIM ABOUT A COMPANY OR ORGANISATION: would a major newspaper print the same line on its opinion page? If yes, don't flag. If it accuses the org of a specific crime or unlawful act with no source, flag.

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
      "turnIndex": <integer — copy the integer straight from the transcript label. The transcript labels turns "T00", "T01", "T02", etc. For a finding about T04, set turnIndex: 4. If the finding genuinely spans the whole debate (e.g. a tone pattern across many turns), use null and explain in the location string.>,
      "location": "<turn reference like 'T04' or a short quoted snippet for human display>",
      "issue": "<one sentence description of the defamatory phrasing>",
      "rationale": "<why this reads as a defamatory claim and would be hard to defend>",
      "suggestion": "<optional rephrase that would keep the substance but remove the risk>"
    }
  ]
}

CRITICAL: every finding MUST include turnIndex (a number, or null if it genuinely spans many turns). The operator review tooling uses turnIndex to bind the finding to the specific message. Don't skip it.`;

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
    let raw = await callModerationModel(PRIMARY_SCREENER, system, user, 8000);
    let parsed = parseFindingsResponse(raw, 'defamation');

    // Retry once on parse failure with an explicit reminder. The
    // dominant parse-failure mode is unescaped quotes inside string
    // values, which a stricter prompt usually fixes on the second
    // attempt. A second failure means the model genuinely can't
    // produce clean JSON for this input — at that point we hold the
    // session (better safe than ship unscreened content).
    if ('error' in parsed) {
      console.warn(`[MODERATION] Defamation parse failed: ${parsed.error}. Retrying with stricter instruction...`);
      const retryUser = user + '\n\nIMPORTANT: Return STRICT JSON only. Inside every string value, escape any double quotes as \\". Do not include literal newlines inside string values — use \\n. Your previous response was not valid JSON.';
      raw = await callModerationModel(PRIMARY_SCREENER, system, retryUser, 8000);
      parsed = parseFindingsResponse(raw, 'defamation');
    }

    const durationSeconds = (Date.now() - startedAt) / 1000;

    if ('error' in parsed) {
      console.error(`[MODERATION] Defamation check parse failed (after retry): ${parsed.error}`);
      return {
        check: 'defamation',
        durationSeconds,
        ok: false,
        findings: [],
        error: `Parse failed after retry: ${parsed.error}`,
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
