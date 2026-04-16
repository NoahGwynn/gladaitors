// ============================================================================
// Debate Templates — v3 utility pivot
// ============================================================================
// Pre-built debate configurations for the use cases the Notion pivot
// doc calls out. Each template pre-fills the topic framing, position
// prompts for each side, and context hints. Selecting a template on
// the /journal/debate form populates the form; the user can still
// edit before clicking Start.
//
// These are the visible product change that signals the utility pivot
// externally: a user who sees "strategy red-team" as a button
// understands what they'd get and why they'd pay for it. A user who
// only sees "start a debate" has to imagine the use case themselves.
//
// Templates aren't restrictive — free-form debates still work. But
// they do conversion work the empty configuration doesn't.
//
// Per Notion's Debate utility pivot page.
// ============================================================================

import type { LucideIcon } from 'lucide-react';
import {
  MessagesSquare,
  Target,
  Compass,
  Scale,
  Users,
  Brain,
} from 'lucide-react';

// ----------------------------------------------------------------------------
// Template-driven form schema
// ----------------------------------------------------------------------------
// Phase B of the v3 utility pivot. Each template now carries a
// description of the form fields it wants to render. The page walks
// the schema and renders the right input for each field. On submit,
// the values get serialised into a structured context block that the
// debating models receive — so a "Product positioning" debate ships
// with a clear product description and supporting URLs as part of
// every prompt, instead of relying on the user to paste it into a
// free-text "additional rules" box.
//
// Three field kinds for now — enough to cover the six templates and
// the open-debate fallback. Add more kinds (file, structured list, …)
// as the pivot deepens.

export type TemplateFieldKind = 'textarea' | 'urlList' | 'candidateList';

interface BaseField {
  /** Stable identifier — used as the React key, the form-state key,
   *  and the heading in the serialised context block. */
  id: string;
  /** Visible label shown above the input. */
  label: string;
  /** Optional helper text rendered under the label. */
  hint?: string;
  /** When true, the field is required for the form to be valid.
   *  Currently advisory — the page validates topic + debaters and
   *  treats template fields as best-effort. Enforce here later if
   *  we want hard-required fields. */
  required?: boolean;
  /** When true, only logged-in users see/use this field. Logged-out
   *  users see a sign-in nudge in its place. URLs and uploads gate
   *  this way because we want the value to actually fetch later
   *  (Phase C / D) and that requires an account. */
  loggedInOnly?: boolean;
}

export interface TextareaField extends BaseField {
  kind: 'textarea';
  placeholder?: string;
  max?: number;
  rows?: number;
}

export interface UrlListField extends BaseField {
  kind: 'urlList';
  /** Maximum number of URL slots the user can add via the "+" button. */
  max: number;
  placeholder?: string;
}

export interface CandidateListField extends BaseField {
  kind: 'candidateList';
  /** Minimum candidates required (defaults to 2). */
  minCandidates?: number;
  /** Maximum candidates the "+" button will allow (defaults to 6). */
  maxCandidates?: number;
}

export type TemplateFormField =
  | TextareaField
  | UrlListField
  | CandidateListField;

// ----------------------------------------------------------------------------
// Template definition
// ----------------------------------------------------------------------------

export interface DebateTemplate {
  /** URL-safe slug — used as the query parameter when linking to the
   *  form with a pre-selected template. */
  slug: string;

  /** Short label shown on the template card */
  name: string;

  /** One-line tagline — the "what this is for" hook */
  tagline: string;

  /** 2-3 sentence description rendered in the template card body */
  description: string;

  /** Lucide icon component shown on the template card and in the
   *  modal header. Stored as a component reference rather than a
   *  string so the type system enforces it exists. */
  icon: LucideIcon;

  /** Label rendered above the topic input. Lets each template ask
   *  the question in its own framing ("What's the role?" for hiring,
   *  "What's the policy question?" for policy, etc) instead of the
   *  generic "What should they debate?". Optional — falls back to
   *  the generic label when omitted. */
  topicLabel?: string;

  /** Placeholder text for the topic input when this template is
   *  active. Teaches the user what to type in without being
   *  prescriptive. */
  topicPlaceholder: string;

  /** Position prompts for each debater seat. The form is a 2-debater
   *  template; third-seat templates can be added later. Index 0 = seat 1,
   *  index 1 = seat 2. */
  positions: [string, string];

  /** Suggested number of rounds. Deeper templates like strategy
   *  red-team benefit from more rounds; quicker templates like
   *  "argue both sides" can run leaner. */
  suggestedRounds: number;

  /** Template-specific form fields rendered in the modal in addition
   *  to (or in place of) the legacy "additional rules" textarea.
   *  Empty array = use the open-debate fallback (free-text context
   *  only). The page walks this array in order. */
  formFields: TemplateFormField[];

  /** Sentence or two appended to each debater's system prompt to tell
   *  the model the *kind* of argument the user is asking for. Distinct
   *  from positions (which describe what to argue) — this describes how
   *  to argue inside this template's frame. Optional; if omitted the
   *  model gets the standard debater system prompt. */
  systemPromptAddendum?: string;

  /** Per-template disclaimer rendered with the completed debate. Used
   *  for templates that touch regulated decision domains (hiring,
   *  legal, etc) where we want a visible reminder that the user is
   *  responsible for the call. The site-wide ToS handles the general
   *  "this is a thinking tool, not advice" framing — this is the
   *  in-context nudge for higher-stakes templates. */
  disclaimer?: string;
}

// Constants reused across templates.
const URL_LIST_MAX = 3;
const SUPPORTING_URLS_HINT =
  'Optional. Up to ' +
  URL_LIST_MAX +
  ' links the models can read into context — docs, articles, internal write-ups. Sign-in required.';

export const DEBATE_TEMPLATES: DebateTemplate[] = [
  {
    slug: 'open',
    name: 'Open debate',
    tagline: 'Configure a free-form debate from scratch.',
    description:
      "The general-purpose debate. You set the topic and each side's position. Use this when none of the structured templates fits, or when you just want to watch two models argue.",
    icon: MessagesSquare,
    topicPlaceholder: 'e.g. Is a banana a berry?',
    positions: ['', ''],
    suggestedRounds: 5,
    formFields: [
      {
        id: 'context',
        kind: 'textarea',
        label: 'Additional rules or context (optional)',
        hint: 'Anything the models should know before they start — facts, constraints, definitions.',
        placeholder: 'e.g. Scientific evidence only.',
        max: 2000,
        rows: 3,
      },
      {
        id: 'supportingUrls',
        kind: 'urlList',
        label: 'Supporting URLs',
        hint: SUPPORTING_URLS_HINT,
        max: URL_LIST_MAX,
        loggedInOnly: true,
        placeholder: 'https://...',
      },
    ],
  },

  {
    slug: 'strategy-red-team',
    name: 'Strategy red-team',
    tagline: "Here's my strategy. Argue why it will fail.",
    description:
      "You lay out a plan. Two models take turns finding the weakest assumptions, the hidden risks, and the scenarios where the whole thing falls apart. You leave with a sharper version of your strategy or a clearer sense of when to abandon it.",
    icon: Target,
    topicLabel: "What's the strategy?",
    topicPlaceholder: 'e.g. We should ship the redesign before building new features',
    positions: [
      "The strategy is sound — defend its core assumptions and name the conditions under which it succeeds",
      "The strategy is flawed — find the weakest assumptions, the hidden risks, and the scenarios where it fails",
    ],
    suggestedRounds: 5,
    systemPromptAddendum:
      "This is a strategy red-team. Your job isn't to entertain — it's to surface failure modes and load-bearing assumptions so the user can stress-test their plan. Be specific. If you're defending, name the conditions under which the plan works; if you're attacking, name the conditions under which it breaks.",
    formFields: [
      {
        id: 'strategyDescription',
        kind: 'textarea',
        label: 'Describe your strategy',
        hint: 'What are you trying to achieve, what are the key moves, and what are you assuming about the market, competitors, or team?',
        placeholder:
          'e.g. We ship the redesign before any new features. The current UI is the top complaint in churn surveys. Plan: refreshed homepage + dashboard, measure sentiment, then resume feature work...',
        max: 4000,
        rows: 6,
        required: true,
      },
      {
        id: 'supportingUrls',
        kind: 'urlList',
        label: 'Supporting links',
        hint: SUPPORTING_URLS_HINT,
        max: URL_LIST_MAX,
        loggedInOnly: true,
        placeholder: 'https://...',
      },
    ],
  },

  {
    slug: 'product-positioning',
    name: 'Product positioning',
    tagline: 'Should this product target X or Y?',
    description:
      "Two candidate positions for a product, service, or feature. Each model argues for one. You watch the trade-offs surface instead of agonising about them alone, then decide which position to commit to.",
    icon: Compass,
    topicLabel: "What's the positioning question?",
    topicPlaceholder: 'e.g. Should our CRM target solo founders or 10-person teams?',
    positions: [
      'Argue the case for targeting the first option — who they are, why they need it, how we win them',
      'Argue the case for the second option — who they are, why they need it, how we win them',
    ],
    suggestedRounds: 5,
    systemPromptAddendum:
      'This is a product positioning debate. Argue the positioning case as if you were on the founding team — make concrete commitments to a buyer, a wedge, a pricing implication, and a go-to-market motion. Vague positioning is bad positioning.',
    formFields: [
      {
        id: 'productDescription',
        kind: 'textarea',
        label: 'Describe the product',
        hint: 'What does it do, who is it for today, what stage is it at?',
        placeholder:
          'e.g. A lightweight CRM built for service businesses. Currently used by ~80 freelancers and small agencies. We track contacts, deals, and follow-ups...',
        max: 3000,
        rows: 5,
        required: true,
      },
      {
        id: 'productUrls',
        kind: 'urlList',
        label: 'Product / supporting links',
        hint:
          'Up to ' +
          URL_LIST_MAX +
          ' URLs — your landing page, a demo, competitor pages, customer interviews. Sign-in required.',
        max: URL_LIST_MAX,
        loggedInOnly: true,
        placeholder: 'https://yourproduct.com',
      },
    ],
  },

  {
    slug: 'policy-tradeoff',
    name: 'Policy trade-off',
    tagline: 'Argue the case for and against this policy choice.',
    description:
      "A structured examination of a policy decision you're weighing. One model argues for adoption, another against. The output is a clear picture of what you gain, what you give up, and the conditions under which each side is right.",
    icon: Scale,
    topicLabel: "What's the policy question?",
    topicPlaceholder: 'e.g. Should we require in-office attendance 3 days a week?',
    positions: [
      'Argue for the policy — the benefits, the problem it solves, the conditions under which it works well',
      'Argue against the policy — the costs, the assumptions it makes, the cases where it backfires',
    ],
    suggestedRounds: 5,
    systemPromptAddendum:
      'This is a policy trade-off. The user is weighing a real decision; surface the second-order effects, the populations who benefit, and the populations who bear the cost. Avoid abstractions — argue from concrete consequences.',
    formFields: [
      {
        id: 'policyDescription',
        kind: 'textarea',
        label: 'Describe the policy',
        hint: 'Who it affects, what problem it aims to address, and any constraints (budget, timeline, scope).',
        placeholder:
          "e.g. We're considering a 3-day office mandate for the engineering team. ~40 people, half hired remote post-2020. The driver is faster onboarding for juniors...",
        max: 3000,
        rows: 5,
        required: true,
      },
      {
        id: 'supportingUrls',
        kind: 'urlList',
        label: 'Supporting links',
        hint: SUPPORTING_URLS_HINT,
        max: URL_LIST_MAX,
        loggedInOnly: true,
        placeholder: 'https://...',
      },
    ],
  },

  {
    slug: 'hiring-decision',
    name: 'Hiring decision',
    tagline: 'Add candidates. Two models argue who to hire.',
    description:
      "Add the finalists. Each candidate gets one model arguing for them. You see both cases side by side, hear the implicit trade-offs, and make a better call than you would by re-reading notes alone.",
    icon: Users,
    topicLabel: "What's the role?",
    topicPlaceholder: 'e.g. Senior backend engineer for the payments team',
    positions: [
      'Argue the case for the first candidate — their strengths, the risks their profile mitigates, what they unlock for the team',
      'Argue the case for the second candidate — their strengths, what they bring that the first does not, what they unlock',
    ],
    suggestedRounds: 5,
    systemPromptAddendum:
      "This is a hiring decision. Argue for your assigned candidate using the brief the user provided — their strengths, what they unlock, and the risks of hiring them. Avoid arguing on identity or signals not in the brief.",
    disclaimer:
      "This debate is a thinking tool — not an employment decision. The arguments below are AI-generated and may misjudge candidates, miss context, or reflect bias in the inputs. Don't use it as the sole basis for hiring or rejection. Make hiring decisions through your normal process, with human review.",
    formFields: [
      {
        id: 'roleDescription',
        kind: 'textarea',
        label: 'The role and what the team needs',
        hint: "What's the team trying to do? What gap does this hire fill?",
        placeholder:
          "e.g. Senior backend engineer for payments. Need someone who can own the Stripe integration end-to-end and mentor two juniors. The team is 5 people, currently no payments specialist...",
        max: 2000,
        rows: 4,
        required: true,
      },
      {
        id: 'candidates',
        kind: 'candidateList',
        label: 'Candidates',
        hint:
          'Add the finalists you want the models to argue between. Each candidate gets one model arguing their case (max 3). Anonymised summaries are fine.',
        minCandidates: 2,
        maxCandidates: 3,
        required: true,
      },
    ],
  },

  {
    slug: 'change-my-mind',
    name: 'Change my mind',
    tagline: "Here's what I think. Try to shift me.",
    description:
      "Tell the models what you currently believe. One model defends your view, the other builds the strongest case against it. You read both side by side and decide whether the attack landed hard enough to move you. If it doesn't, commit with more confidence.",
    icon: Brain,
    topicLabel: "What's your current take, in one line?",
    topicPlaceholder: "e.g. We should kill the free tier",
    positions: [
      "Defend the user's current view — make the strongest case for it, the conditions under which it's right, and where the attack falls short",
      "Try to change the user's mind — make the strongest case against their view. Steelman the alternative without strawmanning their position",
    ],
    suggestedRounds: 3,
    systemPromptAddendum:
      "The user has stated a current view and is asking to be challenged. Whichever side you're on: steelman, don't strawman. If you're defending, name the conditions where the view holds and why the strongest objections fail. If you're attacking, build the case that would actually shift a thoughtful person — not a caricature of one.",
    formFields: [
      {
        id: 'currentView',
        kind: 'textarea',
        label: 'What do you currently think? (and why)',
        hint: "Your view in your own words. Include the reasoning that's pulling you that way — the attacker needs to know what they're up against.",
        placeholder:
          "e.g. We should kill the free tier. It eats support time, the conversion rate is awful, and the users we lose are the ones we don't want anyway. But I'm slightly worried about word-of-mouth...",
        max: 2000,
        rows: 4,
        required: true,
      },
      {
        id: 'supportingUrls',
        kind: 'urlList',
        label: 'Supporting links',
        hint: SUPPORTING_URLS_HINT,
        max: URL_LIST_MAX,
        loggedInOnly: true,
        placeholder: 'https://...',
      },
    ],
  },

];

/** Look up a template by slug. Returns null if the slug doesn't match
 *  a known template. */
export function getTemplateBySlug(slug: string | null | undefined): DebateTemplate | null {
  if (!slug) return null;
  return DEBATE_TEMPLATES.find((t) => t.slug === slug) || null;
}

// ----------------------------------------------------------------------------
// Form value shapes
// ----------------------------------------------------------------------------
// Page state is `Record<fieldId, TemplateFieldValue>` keyed by the
// field's id. The renderer reads/writes values by id.

export interface CandidateValue {
  name: string;
  summary: string;
  url: string;
}

export type TemplateFieldValue =
  | string         // textarea
  | string[]       // urlList
  | CandidateValue[]; // candidateList

export type TemplateFieldValues = Record<string, TemplateFieldValue>;

/** Build an empty value bag for a template — one entry per field with
 *  a sensible empty default per kind. */
export function makeEmptyTemplateValues(template: DebateTemplate): TemplateFieldValues {
  const values: TemplateFieldValues = {};
  for (const field of template.formFields) {
    if (field.kind === 'textarea') {
      values[field.id] = '';
    } else if (field.kind === 'urlList') {
      values[field.id] = [''];
    } else if (field.kind === 'candidateList') {
      const min = field.minCandidates ?? 2;
      values[field.id] = Array.from({ length: min }, () => ({ name: '', summary: '', url: '' }));
    }
  }
  return values;
}

/** Serialise template field values into a Markdown context block to
 *  prepend to the user's free-text context. The block is what the
 *  debating models actually receive — structured so they can find
 *  product description, supporting URLs, candidate briefs, etc.
 *  without prompt-engineering on the user's part. */
export function serialiseTemplateValues(
  template: DebateTemplate,
  values: TemplateFieldValues,
): string {
  const sections: string[] = [];
  for (const field of template.formFields) {
    const value = values[field.id];
    if (value === undefined) continue;

    if (field.kind === 'textarea') {
      const text = String(value).trim();
      if (!text) continue;
      sections.push(`## ${field.label}\n\n${text}`);
    } else if (field.kind === 'urlList') {
      const urls = (value as string[]).map((u) => u.trim()).filter(Boolean);
      if (urls.length === 0) continue;
      sections.push(
        `## ${field.label}\n\n` + urls.map((u) => `- ${u}`).join('\n'),
      );
    } else if (field.kind === 'candidateList') {
      const candidates = (value as CandidateValue[]).filter(
        (c) => c.name.trim() || c.summary.trim() || c.url.trim(),
      );
      if (candidates.length === 0) continue;
      const lines = candidates.map((c, i) => {
        const head = `### Candidate ${i + 1}${c.name.trim() ? `: ${c.name.trim()}` : ''}`;
        const parts: string[] = [head];
        if (c.summary.trim()) parts.push(c.summary.trim());
        if (c.url.trim()) parts.push(`Link: ${c.url.trim()}`);
        return parts.join('\n');
      });
      sections.push(`## ${field.label}\n\n` + lines.join('\n\n'));
    }
  }
  return sections.join('\n\n');
}

/** Whether a template's required fields are filled enough to start a
 *  debate. Topic + per-debater positions are validated separately by the
 *  page; this only checks template-form fields marked `required: true`. */
export function templateFieldsFilled(
  template: DebateTemplate,
  values: TemplateFieldValues,
): boolean {
  for (const field of template.formFields) {
    if (!field.required) continue;
    const value = values[field.id];
    if (value === undefined) return false;
    if (field.kind === 'textarea') {
      if (!String(value).trim()) return false;
    } else if (field.kind === 'urlList') {
      if ((value as string[]).every((u) => !u.trim())) return false;
    } else if (field.kind === 'candidateList') {
      const min = field.minCandidates ?? 2;
      const filled = (value as CandidateValue[]).filter((c) => c.name.trim() || c.summary.trim());
      if (filled.length < min) return false;
    }
  }
  return true;
}
