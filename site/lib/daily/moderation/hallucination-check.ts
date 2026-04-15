// ============================================================================
// the dAIly — Moderation Check 2: Hallucination
// ============================================================================
// Verifies that every factual claim made in the debate is traceable
// to the source material the moderator read during Stage 5a (light
// research) and Stage 5c-i (deep research). Claims that are not
// present in the sources are fabricated and must be flagged.
//
// The highest-value safety step in the whole pipeline. Hallucination
// is the most likely failure mode of AI-generated content, and the
// dAIly's credibility depends on never publishing a claim the models
// made up.
//
// Scope of the check:
//   - Specific numbers (percentages, dates, benchmark results,
//     money amounts, counts)
//   - Named entities (people, companies, papers, institutions)
//   - Direct quotes attributed to a source
//   - Citations to specific studies or reports
//   - Claims about what "X said" or "X published"
//
// NOT flagged:
//   - Reasoning, inference, and analysis the panelists produce on
//     top of the sources (that's the whole point of the debate)
//   - General background knowledge that's common to the subject area
//     (e.g. "large language models are neural networks" in a dAIly
//     AI session — that's not a specific factual claim requiring a
//     citation)
//   - Arguments and positions — these are opinions, not facts
//
// The check reads: research snapshot + deep research snapshot +
// debate transcript. It asks "does every specific factual claim in
// the transcript map to something in the research?"
// ============================================================================

import type { DebateSnapshot } from '../debate-runtime';
import type { ResearchResult, DeepResearchResult } from '../research';
import type { CastParticipant } from '../cast-selection';
import {
  type CategoryCriteria,
  type ModerationCheckResult,
  renderDebateTranscript,
  parseFindingsResponse,
} from '../moderation-pipeline';
import { PRIMARY_SCREENER, callModerationModel } from '../moderation-pool';

export interface HallucinationCheckInput {
  topicTitle: string;
  topicSignificance: string[];
  debateSnapshot: DebateSnapshot;
  cast: CastParticipant[];
  research: ResearchResult;
  deepResearch: DeepResearchResult | null;
  criteria: CategoryCriteria;
}

/** Render the research + deep research into a structured source
 *  block the screener can match claims against. */
function renderSourceMaterial(
  research: ResearchResult,
  deepResearch: DeepResearchResult | null,
): string {
  const lines: string[] = [];

  lines.push('=== LIGHT RESEARCH (Stage 5a) ===');
  if (research.overallSummary) {
    lines.push('');
    lines.push('OVERALL SUMMARY:');
    lines.push(research.overallSummary);
  }
  if (research.synthesisedFacts.length > 0) {
    lines.push('');
    lines.push('SYNTHESISED FACTS (what the sources collectively establish):');
    for (const f of research.synthesisedFacts) lines.push(`  - ${f}`);
  }
  if (research.contestedClaims.length > 0) {
    lines.push('');
    lines.push('CONTESTED CLAIMS (where sources disagree):');
    for (const c of research.contestedClaims) lines.push(`  - ${c}`);
  }
  if (research.openQuestions.length > 0) {
    lines.push('');
    lines.push('OPEN QUESTIONS (known unknowns):');
    for (const q of research.openQuestions) lines.push(`  - ${q}`);
  }
  if (research.timeline && research.timeline.length > 0) {
    lines.push('');
    lines.push('TIMELINE:');
    for (const t of research.timeline) {
      lines.push(`  - ${t.date || '(undated)'}: ${t.event}`);
    }
  }

  if (deepResearch) {
    lines.push('');
    lines.push('=== DEEP RESEARCH (Stage 5c-i) ===');
    if (deepResearch.overallSynthesis) {
      lines.push('');
      lines.push('DEEPER SYNTHESIS:');
      lines.push(deepResearch.overallSynthesis);
    }
    if (deepResearch.keyClaims && deepResearch.keyClaims.length > 0) {
      lines.push('');
      lines.push('KEY CLAIMS WITH CITATIONS:');
      for (const kc of deepResearch.keyClaims) {
        lines.push(`  - ${kc.claim}`);
        for (const cite of kc.citations) {
          lines.push(`      → ${cite.type === 'db' ? 'DB item' : 'Web'}: ${cite.ref}`);
        }
      }
    }
    if (deepResearch.evidenceSnippets && deepResearch.evidenceSnippets.length > 0) {
      lines.push('');
      lines.push('EVIDENCE SNIPPETS PULLED FROM SOURCES:');
      for (const s of deepResearch.evidenceSnippets) {
        lines.push(`  - "${s.snippet}"`);
        lines.push(`      relevance: ${s.relevance}`);
      }
    }
    if (deepResearch.gapsInCoverage && deepResearch.gapsInCoverage.length > 0) {
      lines.push('');
      lines.push('GAPS IN COVERAGE (areas sources do NOT address — claims about these are unsupported):');
      for (const g of deepResearch.gapsInCoverage) lines.push(`  - ${g}`);
    }
  }

  return lines.join('\n');
}

function buildPrompt(input: HallucinationCheckInput): { system: string; user: string } {
  const { criteria } = input;

  const system = `You are a hallucination screening model for the dAIly, an editorial product that publishes AI-generated debates. Your job is to verify that every specific factual claim made in the debate transcript is supported by the source material the moderator read during research.

THIS IS THE HIGHEST-VALUE CHECK IN THE PIPELINE. Hallucination is the most likely failure mode — models confidently state numbers, dates, names, and quotes that don't exist. Publishing hallucinated claims would destroy the dAIly's credibility. Your job is to catch these before publication.

WHAT TO CHECK

For every specific factual claim in the debate transcript, ask: is this supported by the source material? Specific factual claims include:
  - Numbers (percentages, counts, dollar amounts, dates, benchmarks, parameter counts)
  - Named entities (people, companies, products, institutions, papers, reports)
  - Direct quotes attributed to a source
  - Citations to specific studies, papers, or reports
  - Statements about what "X said" or "X published" or "X announced"
  - Specific event dates or sequences

For each one, check: is this in the source material? If yes, pass. If no, flag it.

WHAT NOT TO CHECK

You are not checking the panelists' reasoning, analysis, or arguments. Those are the substance of the debate and the whole point of running it. Do NOT flag:
  - Inferences drawn from sourced facts ("if X is true, then Y follows")
  - Arguments and positions the panelists take
  - General background knowledge common to the subject area
  - Hypotheticals and thought experiments ("imagine if Y were true")
  - Analysis of tradeoffs and implications

The line is: a factual claim versus a reasoned position. "GPT-5 achieved 87% on MMLU" is a factual claim that must be sourceable. "GPT-5 represents a meaningful capability jump" is an analytical position — not your concern.

CATEGORY EMPHASIS

This is a ${criteria.label} category debate. Subject: ${criteria.subject}

Pay particular attention to: ${criteria.emphases.hallucination}

${criteria.hardProhibitions.length > 0 ? `HARD PROHIBITIONS — any instance is an automatic critical finding:\n${criteria.hardProhibitions.map(p => `  - ${p}`).join('\n')}` : ''}

SEVERITY

  - critical — a specific, verifiable factual claim (number, date, quote, citation) that is not in the source material. Must block publication. These are the hallucinations we exist to catch.
  - minor — a general claim that's broadly reasonable but could benefit from a source hook. Does not block publication.

OUTPUT

Respond with JSON only. Your job is to flag real hallucinations, not to find something wrong. If every factual claim is properly sourced, return an empty findings array. Clean output is the correct answer when the content is clean.

{
  "findings": [
    {
      "severity": "critical" | "minor",
      "location": "<turn reference like 'T04' or a short quoted snippet>",
      "issue": "<one sentence: what specific factual claim is not in the sources>",
      "rationale": "<what a reader would expect to find in the source material if this claim were true, and what's actually there>",
      "suggestion": "<optional: if the claim is salvageable (e.g. the source has similar data the panelist misremembered), suggest how to rephrase>"
    }
  ]
}`;

  const transcript = renderDebateTranscript(input.debateSnapshot, input.cast);
  const sourceMaterial = renderSourceMaterial(input.research, input.deepResearch);

  const user = `TOPIC: ${input.topicTitle}
${input.topicSignificance.length > 0 ? `SIGNIFICANCE: ${input.topicSignificance.join(' | ')}` : ''}

CATEGORY: ${criteria.label}

====================================================================
SOURCE MATERIAL (everything the moderator read before running the debate)
====================================================================

${sourceMaterial}

====================================================================
DEBATE TRANSCRIPT
====================================================================

${transcript}

Run the hallucination check. For every specific factual claim in the transcript, verify it's supported by the source material above. Return findings in the JSON shape specified.`;

  return { system, user };
}

export async function runHallucinationCheck(
  input: HallucinationCheckInput,
): Promise<ModerationCheckResult> {
  const startedAt = Date.now();
  console.log(`[MODERATION] Running hallucination check...`);

  const { system, user } = buildPrompt(input);

  try {
    const raw = await callModerationModel(PRIMARY_SCREENER, system, user, 12000);
    const parsed = parseFindingsResponse(raw, 'hallucination');

    const durationSeconds = (Date.now() - startedAt) / 1000;

    if ('error' in parsed) {
      console.error(`[MODERATION] Hallucination check parse failed: ${parsed.error}`);
      return {
        check: 'hallucination',
        durationSeconds,
        ok: false,
        findings: [],
        error: `Parse failed: ${parsed.error}`,
      };
    }

    const criticalCount = parsed.findings.filter(f => f.severity === 'critical').length;
    const minorCount = parsed.findings.filter(f => f.severity === 'minor').length;
    console.log(`[MODERATION] Hallucination check done in ${durationSeconds.toFixed(1)}s: ${criticalCount} critical, ${minorCount} minor`);

    return {
      check: 'hallucination',
      durationSeconds,
      ok: true,
      findings: parsed.findings,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    const durationSeconds = (Date.now() - startedAt) / 1000;
    console.error(`[MODERATION] Hallucination check failed: ${msg}`);
    return {
      check: 'hallucination',
      durationSeconds,
      ok: false,
      findings: [],
      error: msg,
    };
  }
}
