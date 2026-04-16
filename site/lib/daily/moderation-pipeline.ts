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
        'Claims about named individual researchers, executives, or employees — not generic critique of labs as organisations. Lab-level critique ("OpenAI ships fast", "Google is rushing", "Anthropic, including us, downplays X") is editorial commentary and should pass. The risk is named-individual claims and accusations of specific unlawful conduct (regulatory breach, fraud) against a named org.',
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
        'Claims about NAMED individual researchers — not generic critique of fields, journals, or institutions. Critical assessment of methodology, journal practices, or institutional incentives is editorial commentary and should pass. The risk is naming a specific researcher with an accusation of fraud, p-hacking, fabrication, or misconduct that the sources do not directly support.',
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
        'Claims about a NAMED executive or employee — not company-level critique. Critical commentary on company strategy, product decisions, or competitive behaviour is editorial substance and should pass. Risk: naming a specific person and attributing a failure or motive to them as fact, or accusing a named company of a specific unlawful act (regulatory breach, antitrust violation) without sourcing.',
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
        'Claims about NAMED individual artists or critics — not critique of works, movements, or institutions in the abstract. Critical assessment of a creative work or an institution is opinion journalism and should pass. Risk: accusing a specific named artist of plagiarism, theft, fraud, or misconduct without source attribution.',
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
        'Claims about a NAMED individual researcher or politician — not generic critique of governments, industries, or fossil-fuel companies. Critical assessment of policy, corporate behaviour, or institutional incentives is editorial substance. Risk: naming a specific scientist with a fraud accusation, or accusing a named company of a specific regulatory breach without sourcing.',
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
        'Claims about a NAMED individual teacher, administrator, or researcher — not generic critique of curricula, school systems, or universities. Critical commentary on policy and institutional approaches is editorial substance. Risk: a named individual accused of misconduct, harm to students, or fraud without sourcing.',
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
        'Claims about a NAMED individual maintainer or contributor — not critique of projects, frameworks, or communities in the abstract. Critical assessment of code quality, architectural decisions, or community governance is editorial substance. Risk: accusing a named maintainer of malicious behaviour, sabotage, or hostility without sourcing.',
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
        'Claims about a NAMED individual practitioner or researcher — not generic critique of pharma, regulators, or healthcare systems. Critical commentary on industry behaviour, regulatory failure, or institutional incentives is editorial substance. Risk: naming a specific clinician with a malpractice or fraud accusation without sourcing, or accusing a named drug company of a specific regulatory breach.',
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
      'Claims about NAMED individuals presented as fact rather than opinion. Generic critique of organisations, governments, industries, or policies is editorial commentary and should pass — newspapers print this kind of opinion every day. The risk is named-individual accusations and accusations of specific unlawful conduct (regulatory breach, fraud) against a named org without sourcing.',
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
   *  turn reference (e.g. "T04" or a quoted snippet). Kept for
   *  display; finding→turn binding uses turnIndex. */
  location: string;
  /** Structured turn index that matches DebateTurn.index in the
   *  debate snapshot. Set when the finding is bound to one specific
   *  turn. Lets the operator UI hide / approve / rerun the exact turn
   *  rather than blanking the whole debate. Null when the finding
   *  spans multiple turns or the whole session — those fall through
   *  to the legacy "hide the body" hold behaviour. */
  turnIndex?: number | null;
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

/** Escape literal newlines that appear inside JSON string values.
 *  Walks the input character by character tracking whether we're
 *  inside a quoted string; when we are, raw \n / \r get replaced with
 *  the JSON escape sequence so JSON.parse stops choking on them. */
function escapeNewlinesInStrings(input: string): string {
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      if (ch === '"') inString = true;
      out += ch;
    }
  }
  return out;
}

/** Shared JSON parser for check responses. Each check returns a JSON
 *  object with a `findings` array; this extracts and sanitises it.
 *
 *  Resilience strategy: the screener models occasionally emit slightly
 *  malformed JSON (trailing commas, literal newlines inside string
 *  values, smart quotes). We try a strict parse first, then a series
 *  of cheap repairs before giving up. The check itself retries the
 *  call once on a parse failure return — this parser is the first
 *  line of defence. */
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

    const slice = text.slice(jsonStart, jsonEnd + 1);

    // Try a series of progressively more aggressive repairs. Stop at
    // the first one that parses cleanly. If none work, fall through
    // to the error path so the check returns ok: false.
    const candidates: string[] = [
      slice,
      // Strip trailing commas before } or ]
      slice.replace(/,\s*([}\]])/g, '$1'),
      // Replace smart quotes with straight quotes (some models emit
      // curly quotes that JSON doesn't recognise)
      slice.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'"),
      // Escape literal newlines inside string values. JSON forbids
      // them, but models occasionally embed them in the rationale or
      // suggestion fields. This conservative pass only touches
      // newlines that are clearly inside quoted strings.
      escapeNewlinesInStrings(slice.replace(/,\s*([}\]])/g, '$1')),
    ];

    let parsed: Record<string, unknown> | null = null;
    for (const candidate of candidates) {
      try {
        parsed = JSON.parse(candidate) as Record<string, unknown>;
        break;
      } catch {
        continue;
      }
    }
    if (!parsed) {
      // Last attempt: re-throw the strict parse to capture a useful error message.
      JSON.parse(slice);
      // Unreachable, but satisfies the type narrowing.
      return { error: 'parse failed' };
    }

    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];

    const findings: ModerationFinding[] = (rawFindings as Array<Record<string, unknown>>).map(f => {
      const severity: 'critical' | 'minor' =
        f.severity === 'critical' ? 'critical' : 'minor';
      const location = typeof f.location === 'string' ? f.location : '(unspecified)';
      // Prefer the structured turnIndex the prompt now asks for. Fall
      // back to extracting "T04" / "T4" patterns from the location
      // string for backwards compat with older snapshots.
      let turnIndex: number | null = null;
      if (typeof f.turnIndex === 'number' && Number.isFinite(f.turnIndex) && f.turnIndex >= 0) {
        turnIndex = Math.floor(f.turnIndex);
      } else {
        const match = location.match(/\bT(\d{1,3})\b/);
        if (match) turnIndex = Number.parseInt(match[1], 10);
      }
      return {
        check,
        severity,
        location,
        turnIndex,
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
