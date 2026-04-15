// ============================================================================
// the dAIly — Shared Moderation Pipeline (Stage 7)
// ============================================================================
// Runs three screening checks on every generated debate before
// publication:
//
//   1. Defamation  — flags phrasings that could constitute defamatory
//                    claims (someone is lying, claims of motive, claims
//                    of criminal conduct, contradictions of official
//                    positions presented as fact)
//   2. Hallucination — verifies every factual claim in the debate is
//                      traceable to source material from the research
//                      snapshot. Unsupported claims are flagged.
//   3. Tone/Bias   — reviews for partisan framing, loaded language,
//                    asymmetric treatment of perspectives. NOT false
//                    balance — catches editorial-position signalling.
//
// Each check returns structured findings with severity:
//   - 'critical' — blocks publication; session is held_for_moderation
//   - 'minor'    — passes, logged as a warning, still publishes
//
// The critical rule: SKIPPING IS ALWAYS ACCEPTABLE. A skipped day is
// fine. A bad day is not. If any critical finding is raised, the
// session sits in held_for_moderation until the operator clears it
// manually.
//
// Per-category criteria tune the emphasis of each check without
// duplicating the check modules. dAIly AI emphasises technical
// accuracy about model capabilities; dAIly Science emphasises citation
// accuracy; dAIly Medicine prohibits treatment advice; etc.
//
// Cost: ~3 Claude Sonnet calls per session. ~£0.30 per session
// typical. Trivial compared to the generation cost.
// ============================================================================

import type { DebateSnapshot } from './debate-runtime';
import type { ResearchResult, DeepResearchResult } from './research';
import type { CastParticipant } from './cast-selection';
import { runDefamationCheck } from './moderation/defamation-check';
import { runHallucinationCheck } from './moderation/hallucination-check';
import { runToneBiasCheck } from './moderation/tone-bias-check';

// --- Per-category criteria ---

export interface CategoryCriteria {
  /** Human-readable category label — shown in prompts */
  label: string;
  /** Short description of what this category is about — injected into
   *  every check prompt so the screener knows the subject context */
  subject: string;
  /** Emphases for each check — these get appended to the base check
   *  prompts as "pay particular attention to:" guidance */
  emphases: {
    defamation: string;
    hallucination: string;
    toneBias: string;
  };
  /** Explicit prohibitions that translate to automatic critical
   *  findings if triggered. e.g. dAIly Medicine prohibits treatment
   *  advice full stop. */
  hardProhibitions: string[];
}

/** Per-category moderation criteria. Only `ai` is fully populated in
 *  v1 — other categories have sensible defaults that get refined as
 *  each launches. Add new categories here when they come online. */
export const MODERATION_CRITERIA: Record<string, CategoryCriteria> = {
  ai: {
    label: 'AI',
    subject: 'Frontier AI model research, capabilities, safety, deployment, and the labs that build them.',
    emphases: {
      defamation:
        'Claims about named labs (OpenAI, Anthropic, Google DeepMind, Meta, etc.) or named researchers presented as fact rather than opinion. Claims of intent, motive, or strategic deception against a specific company. Attribution of failures to individual employees.',
      hallucination:
        'Benchmark numbers, model release dates, company announcements, publication citations, and parameter counts. These are the most-hallucinated factual categories in AI writing and must all be traceable to the source material.',
      toneBias:
        'Asymmetric treatment of competing labs (e.g. harsher tone toward one lab than another for the same kind of behaviour). Overclaim about model capabilities ("revolutionary", "paradigm-shifting") without evidence weight. Underclaim of safety risks.',
    },
    hardProhibitions: [
      'Naming an individual employee or researcher in a critical claim without a source attribution',
      'Predicting company financial outcomes or stock movements',
    ],
  },

  // Placeholder stubs for Tier 1-2 categories. Fill in per-category
  // emphases when each launches. Hard prohibitions stay empty until
  // the category's launch review decides them.
  science: {
    label: 'Science',
    subject: 'Scientific research — papers, findings, methodology, replication, and the institutions that produce them.',
    emphases: {
      defamation:
        'Claims about individual researchers or institutions presented as fact. Accusations of fraud, p-hacking, or misconduct without evidence directly in the sources.',
      hallucination:
        'Citation accuracy is paramount. Every study cited must be in the source material. DOIs, author names, publication years, and effect sizes are the highest-risk fabrication categories.',
      toneBias:
        'Overclaiming about new findings ("breakthrough", "proves") when sources are preliminary or single-study. Dismissing established findings with single counter-studies.',
    },
    hardProhibitions: [
      'Treatment or dosage recommendations of any kind',
      'Health claims presented as medical advice',
    ],
  },

  tech: {
    label: 'Tech',
    subject: 'Technology industry — product launches, platform decisions, infrastructure, and the companies that ship them.',
    emphases: {
      defamation:
        'Claims about executive motive or competitive intent. Attribution of product failures to individual employees or teams.',
      hallucination:
        'Product launch dates, pricing, feature lists, and company financials. Distinguish announcement from availability — "announced" and "shipping" are not the same thing.',
      toneBias:
        'Hype language that treats announcement as reality. Asymmetric framing of similar moves by different companies.',
    },
    hardProhibitions: [],
  },

  arts: {
    label: 'Arts',
    subject: 'Arts and culture — creative works, artists, institutions, and critical reception.',
    emphases: {
      defamation:
        'Claims about individual artists, institutions, or critics presented as fact. Accusations of plagiarism, theft, or fraud without source attribution.',
      hallucination:
        'Attributing works to wrong artists, inventing titles or release details, citing awards or exhibitions that did not happen.',
      toneBias:
        'Gratuitous negativity toward individual artists. Underlying critical assessment is fine; personal attacks are not.',
    },
    hardProhibitions: [],
  },

  climate: {
    label: 'Climate',
    subject: 'Climate science, energy policy, and the institutions that shape them.',
    emphases: {
      defamation:
        'Claims about researcher motive or institutional bias. Accusations against specific governments or companies presented as fact.',
      hallucination:
        'Temperature figures, emissions data, policy timelines, and scientific consensus claims. All must be traceable to the source material.',
      toneBias:
        'Mixing established science with contested policy. The science side is settled; the policy side is not. Framing must not conflate them.',
    },
    hardProhibitions: [
      'Presenting contested policy choices as scientific consensus',
    ],
  },

  education: {
    label: 'Education',
    subject: 'Education research, pedagogy, and institutions.',
    emphases: {
      defamation:
        'Claims about individual teachers, administrators, or institutions presented as fact.',
      hallucination:
        'Student outcome data, research study details, policy descriptions.',
      toneBias:
        'Prescriptive claims about what works in classrooms when the evidence is weak or context-dependent.',
    },
    hardProhibitions: [
      'Prescriptive pedagogical claims presented as universal truth',
    ],
  },

  code: {
    label: 'Code',
    subject: 'Software engineering — languages, frameworks, libraries, and the communities that maintain them.',
    emphases: {
      defamation:
        'Claims about library maintainers or open-source communities presented as fact.',
      hallucination:
        'API signatures, version numbers, breaking change details, benchmark results. These are heavily hallucinated in technical writing.',
      toneBias:
        'Framing trend adoption as inevitability. Dismissing incumbent technologies with single-source critiques.',
    },
    hardProhibitions: [],
  },

  medicine: {
    label: 'Medicine',
    subject: 'Medical research, clinical practice, and health policy.',
    emphases: {
      defamation:
        'Claims about individual practitioners, drug companies, or regulatory bodies presented as fact.',
      hallucination:
        'Study details, dosages, effect sizes, regulatory approvals. Strictest citation standard in the entire family.',
      toneBias:
        'Overclaim of treatment efficacy or risk. Underclaim of uncertainty.',
    },
    hardProhibitions: [
      'Any treatment, dosage, or diagnostic recommendation',
      'Health advice presented to readers as applicable to their individual situation',
    ],
  },
};

/** Fallback criteria for any category not explicitly in the map. Uses
 *  generic language; the operator should add a specific entry before
 *  launching a category publicly. */
const DEFAULT_CRITERIA: CategoryCriteria = {
  label: 'General',
  subject: 'General daily investigation topic.',
  emphases: {
    defamation:
      'Claims about named individuals or organisations presented as fact rather than opinion.',
    hallucination:
      'All factual claims must be traceable to the source material attached to the session.',
    toneBias:
      'Partisan framing, loaded language, asymmetric treatment of perspectives.',
  },
  hardProhibitions: [],
};

export function getCategoryCriteria(category: string): CategoryCriteria {
  return MODERATION_CRITERIA[category.toLowerCase()] || DEFAULT_CRITERIA;
}

// --- Result types ---

/** A single finding raised by one of the screening checks. */
export interface ModerationFinding {
  /** Which check raised it */
  check: 'defamation' | 'hallucination' | 'tone_bias';
  /** Severity — critical blocks publication, minor is a warning only */
  severity: 'critical' | 'minor';
  /** Where in the debate the problem is. Free-text quoted snippet or
   *  turn reference. */
  location: string;
  /** One-sentence description of what's wrong */
  issue: string;
  /** Why it matters — the reasoning the screener gave */
  rationale: string;
  /** What would need to change for this to pass */
  suggestion?: string;
}

/** Result of one of the three screening checks. */
export interface ModerationCheckResult {
  check: 'defamation' | 'hallucination' | 'tone_bias';
  /** Seconds spent on this check (wall-clock) */
  durationSeconds: number;
  /** Whether the check finished without errors. A failed check is
   *  treated as a critical finding by the overall pipeline because
   *  we can't publish without knowing what's in the content. */
  ok: boolean;
  /** All findings raised, including both critical and minor */
  findings: ModerationFinding[];
  /** Error message if ok=false */
  error?: string;
}

/** The full moderation pipeline output — stored in the
 *  moderation_snapshot column. */
export interface ModerationPipelineResult {
  /** ISO timestamp when the pipeline started running */
  startedAt: string;
  /** ISO timestamp when the pipeline finished */
  completedAt: string;
  /** Which model ran the checks (for the transparency layer) */
  screenerModelId: string;
  /** Category criteria used — snapshot so later tuning doesn't
   *  invalidate historical decisions */
  criteriaLabel: string;
  /** Per-check results */
  checks: ModerationCheckResult[];
  /** The overall decision — publish, hold, or (v2) revise */
  decision: 'publish' | 'hold';
  /** Human-readable summary of why the decision was made */
  decisionReason: string;
  /** Count of critical findings across all checks */
  criticalCount: number;
  /** Count of minor findings across all checks */
  minorCount: number;
}

// --- Orchestrator ---

export interface RunModerationPipelineInput {
  category: string;
  topicTitle: string;
  topicSignificance: string[];
  debateSnapshot: DebateSnapshot;
  /** Used by the hallucination check — the source material the debate
   *  was supposed to be grounded in. Mandatory. */
  research: ResearchResult;
  /** Optional — additional source material from deep research that
   *  the debate may have drawn on */
  deepResearch: DeepResearchResult | null;
  /** Cast list — used by the checks to refer to panelists by name */
  cast: CastParticipant[];
}

/** Run the three moderation checks in sequence and produce a publish/
 *  hold decision. Does NOT write to the database — the caller
 *  (/api/daily/cron/debate) persists the result. */
export async function runModerationPipeline(
  input: RunModerationPipelineInput,
): Promise<ModerationPipelineResult> {
  const startedAt = new Date().toISOString();
  const criteria = getCategoryCriteria(input.category);

  console.log(`[MODERATION] Starting pipeline for ${input.category} on "${input.topicTitle}"`);
  console.log(`[MODERATION] Using criteria: ${criteria.label}`);

  const checks: ModerationCheckResult[] = [];

  // 1. Defamation check
  checks.push(await runDefamationCheck({
    topicTitle: input.topicTitle,
    debateSnapshot: input.debateSnapshot,
    cast: input.cast,
    criteria,
  }));

  // 2. Hallucination check
  checks.push(await runHallucinationCheck({
    topicTitle: input.topicTitle,
    topicSignificance: input.topicSignificance,
    debateSnapshot: input.debateSnapshot,
    cast: input.cast,
    research: input.research,
    deepResearch: input.deepResearch,
    criteria,
  }));

  // 3. Tone and bias check
  checks.push(await runToneBiasCheck({
    topicTitle: input.topicTitle,
    debateSnapshot: input.debateSnapshot,
    cast: input.cast,
    criteria,
  }));

  const completedAt = new Date().toISOString();

  // Tally findings
  const allFindings = checks.flatMap(c => c.findings);
  const criticalCount = allFindings.filter(f => f.severity === 'critical').length;
  const minorCount = allFindings.filter(f => f.severity === 'minor').length;

  // A check that errored counts as a critical finding — we can't
  // publish content we haven't screened.
  const erroredChecks = checks.filter(c => !c.ok);
  const erroredCount = erroredChecks.length;

  let decision: ModerationPipelineResult['decision'];
  let decisionReason: string;

  if (erroredCount > 0) {
    decision = 'hold';
    const errorList = erroredChecks.map(c => `${c.check} (${c.error?.slice(0, 80) || 'unknown'})`).join(', ');
    decisionReason = `Held because ${erroredCount} of 3 screening checks errored: ${errorList}. Can't publish content we haven't screened. Operator should review the session manually.`;
  } else if (criticalCount > 0) {
    decision = 'hold';
    const byCheck = checks
      .filter(c => c.findings.some(f => f.severity === 'critical'))
      .map(c => {
        const critCount = c.findings.filter(f => f.severity === 'critical').length;
        return `${c.check} (${critCount})`;
      })
      .join(', ');
    decisionReason = `Held because ${criticalCount} critical finding${criticalCount === 1 ? '' : 's'} raised across: ${byCheck}. Review the findings in the moderation snapshot before publishing.`;
  } else {
    decision = 'publish';
    decisionReason = minorCount > 0
      ? `Passed all three checks. ${minorCount} minor finding${minorCount === 1 ? '' : 's'} logged as warnings — they do not block publication.`
      : 'Passed all three checks with zero findings.';
  }

  console.log(`[MODERATION] Decision: ${decision}. ${decisionReason}`);

  return {
    startedAt,
    completedAt,
    screenerModelId: 'claude-sonnet',
    criteriaLabel: criteria.label,
    checks,
    decision,
    decisionReason,
    criticalCount,
    minorCount,
  };
}

// --- Shared helpers for the check modules ---

/** Render the debate into a single plain-text transcript that the
 *  screening models read. All three checks use the same rendering
 *  so findings can reference turn numbers consistently. */
export function renderDebateTranscript(
  debateSnapshot: DebateSnapshot,
  cast: CastParticipant[],
): string {
  const nameBySeat = new Map<number, string>();
  for (const c of cast) nameBySeat.set(c.seat, c.modelName);

  const lines: string[] = [];
  for (const turn of debateSnapshot.turns) {
    const index = `T${String(turn.index).padStart(2, '0')}`;
    if (turn.actor === 'moderator') {
      const target = turn.targetSeat != null ? ` → ${nameBySeat.get(turn.targetSeat) || `Seat ${turn.targetSeat}`}` : '';
      lines.push(`${index}  MODERATOR${target}`);
      if (turn.move) lines.push(`       move: ${turn.move}`);
      lines.push(`       ${turn.text}`);
    } else {
      const name = turn.seat != null ? (nameBySeat.get(turn.seat) || `Seat ${turn.seat}`) : 'UNKNOWN';
      lines.push(`${index}  ${name.toUpperCase()}`);
      lines.push(`       ${turn.text}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Shared JSON parser for check responses. Each check returns a JSON
 *  object with a `findings` array; this extracts and sanitises it. */
export function parseFindingsResponse(
  raw: string,
  check: ModerationFinding['check'],
): { findings: ModerationFinding[] } | { error: string } {
  try {
    let text = raw.trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) text = fenceMatch[1].trim();

    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return { error: 'No JSON object found in response' };

    let jsonStr = text.slice(jsonStart, jsonEnd + 1);
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];

    const findings: ModerationFinding[] = (rawFindings as Array<Record<string, unknown>>).map(f => {
      const severity: 'critical' | 'minor' =
        f.severity === 'critical' ? 'critical' : 'minor';
      return {
        check,
        severity,
        location: typeof f.location === 'string' ? f.location : '(unspecified)',
        issue: typeof f.issue === 'string' ? f.issue : '(no description)',
        rationale: typeof f.rationale === 'string' ? f.rationale : '',
        suggestion: typeof f.suggestion === 'string' ? f.suggestion : undefined,
      };
    });

    return { findings };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'parse failed' };
  }
}
