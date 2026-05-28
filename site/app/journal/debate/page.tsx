// ============================================================================
// Debate Arena — /journal/debate
// ============================================================================
// Two-panel layout: form (left) + debate thread (right).
// Streams responses via SSE as models argue sequentially.
//
// STATE DESIGN:
//   Form state (left panel)  — topic, debaters, rounds, context
//   Debate state (right panel) — currentDebate + liveArguments
//   These are independent. The form never drives the display.
//
// DEBATER IDENTITY:
//   Each debater is identified by their slot index (0, 1, 2), not model_id.
//   This allows the same model to appear in multiple slots (e.g., Claude vs Claude).
//   Display names are disambiguated: "Claude 1", "Claude 2" when duplicates exist.
// ============================================================================

'use client';

import { useState, useRef, useEffect, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import { config } from '@/lib/config';
import {
  getUserDebates, deleteDebate, fetchDebateById,
} from '@/lib/debates';
import { fetchTokenBalance, notifyBalanceChanged, onBalanceChanged } from '@/lib/tokens';
import { createClient } from '@/lib/supabase';
import {
  useDebateStatus, useDebateStream, useDebateActions,
  type DebaterConfig,
} from '@/lib/orchestrator/DebateOrchestratorProvider';
import type { Debate } from '@/lib/types';
import type { DebateArgument } from '@/lib/types';
import ModelSelect from '@/components/ModelSelect';
import AuthModal from '@/components/AuthModal';
import ShareMenu from '@/components/ShareMenu';
import ShareModal from '@/components/ShareModal';
import BuyTokensModal from '@/components/BuyTokensModal';
import VotingPanel, { type VoteOption } from '@/components/VotingPanel';
import UserTurnInput from '@/components/UserTurnInput';
import ExtendDebateModal from '@/components/ExtendDebateModal';
import { STARTER_TOPICS } from '@/lib/starter-topics';
import {
  DEBATE_TEMPLATES,
  getTemplateBySlug,
  makeEmptyTemplateValues,
  serialiseTemplateValues,
  templateFieldsFilled,
  type DebateTemplate,
  type TemplateFieldValues,
} from '@/lib/debate-templates';
import TemplateFormFields from '@/components/TemplateFormFields';
import DecisionSynthesis from './[id]/DecisionSynthesis';
import { MODELS, findModel, getModelColour, getModelName, getModelTokenCost } from '@/lib/models';
import { X, LockKeyhole, ChevronRight, ChevronLeft, Loader2 } from 'lucide-react';
import styles from './page.module.scss';

/** Generate unique display names — adds numbering when the same model appears twice.
 *  User slots use "Human" as the base label (not the picker name "Me").
 */
function getDisplayNames(debaters: DebaterConfig[]): string[] {
  const counts: Record<string, number> = {};
  debaters.forEach(d => { counts[d.modelId] = (counts[d.modelId] || 0) + 1; });

  const seen: Record<string, number> = {};
  return debaters.map(d => {
    const model = findModel(d.modelId);
    const base = model?.family === 'user' ? 'Human' : getModelName(d.modelId);
    if (counts[d.modelId] === 1) return base;
    seen[d.modelId] = (seen[d.modelId] || 0) + 1;
    return `${base} ${seen[d.modelId]}`;
  });
}

function formatModelList(debaters: DebaterConfig[]): string {
  const names = getDisplayNames(debaters);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// --- Types ---
// DebaterConfig, LiveArgument, and ActiveDebate are now provided by
// @/lib/orchestrator/DebateOrchestratorProvider so the page and the
// orchestrator agree on shape.

/** Find the next debater that needs to argue for an incomplete debate.
 *  Walks rounds in order, then debaters within each round, and returns the
 *  first slot that doesn't yet have an argument. Returns null if the debate
 *  is fully argued. Moderator notes are ignored — they aren't debater turns.
 */
function findNextDebaterToArgue(
  debaters: DebaterConfig[],
  args: DebateArgument[],
  totalRounds: number,
): { round: number; debaterIndex: number; isUser: boolean } | null {
  for (let r = 1; r <= totalRounds; r++) {
    for (let i = 0; i < debaters.length; i++) {
      const has = args.some(a => a.round === r && a.debater_index === i && a.model_id !== 'moderator');
      if (!has) {
        return {
          round: r,
          debaterIndex: i,
          isUser: findModel(debaters[i].modelId)?.family === 'user',
        };
      }
    }
  }
  return null;
}

// ============================================================================
// Component
// ============================================================================

export default function DebateArenaPage() {
  return (
    <Suspense>
      <DebateArenaContent />
    </Suspense>
  );
}

function DebateArenaContent() {
  const searchParams = useSearchParams();

  // --- Form state (left panel only — page-local) ---
  const [topic, setTopic] = useState(searchParams.get('topic') || '');
  const [debaters, setDebaters] = useState<DebaterConfig[]>([
    { modelId: 'claude-sonnet', position: '' },
    { modelId: 'gpt-4o', position: '' },
  ]);
  const [rounds, setRounds] = useState(3);
  const [context, setContext] = useState('');
  const [revealIdentities, setRevealIdentities] = useState(true);
  const [responseLength, setResponseLength] = useState<'concise' | 'detailed'>('detailed');

  // --- Template state ---
  // v3 utility pivot: pre-built templates for common decision use cases.
  // Selecting a template pre-fills the form; the user can still edit
  // before starting. Deep-link via ?template=<slug> so homepage entry
  // points land directly on a configured form.
  const [selectedTemplate, setSelectedTemplate] = useState<DebateTemplate | null>(() =>
    getTemplateBySlug(searchParams.get('template')),
  );

  // Per-template form field values (Phase B). Each template carries its
  // own form schema; this bag holds the answers, keyed by field id. Reset
  // when the template changes — a fresh template starts from empty
  // defaults derived from the schema (one URL slot, two candidate cards,
  // etc).
  const [templateFieldValues, setTemplateFieldValues] = useState<TemplateFieldValues>(() => {
    const initial = getTemplateBySlug(searchParams.get('template'));
    return initial ? makeEmptyTemplateValues(initial) : {};
  });

  // --- Debate state (sourced from the layout-mounted orchestrator provider) ---
  // Lifting this state out of the page is what allows in-app navigation
  // (history sidebar, /explore, etc.) without killing the running debate.
  const {
    activeDebate, generating, error, errorReason, justCompleted,
    dbAwaitingHuman, isFollowing, dbDriverStale, canTakeOver,
  } = useDebateStatus();
  const { liveArguments, currentThinking, pendingUserTurn } = useDebateStream();
  const {
    startDebate, continueDebate, extendActiveDebate,
    loadDebate, resetDebate, takeOverDebate,
    submitUserTurn, updateActiveDebate,
    acknowledgeJustCompleted,
  } = useDebateActions();

  // --- UI state ---
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [history, setHistory] = useState<Debate[]>([]);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [tokenBalance, setTokenBalance] = useState<number | null>(null);
  const [showBuyTokens, setShowBuyTokens] = useState(false);
  const [showExtendModal, setShowExtendModal] = useState(false);

  // Form lives in a modal overlay. Auto-open is intentionally narrow
  // (avoid the "popup ad" feeling for returning users):
  //
  //   - Deep-link (?template= / ?topic=) → open. Signals explicit intent.
  //   - Logged-in user with empty history → open once it loads. First-
  //     time experience nudge — they just signed up, give them the
  //     action immediately rather than making them scan the hero.
  //   - Otherwise → closed. Hero / sample / history acts as the marketing
  //     surface, and the user opens via "New debate" / hero CTA.
  const [isFormOpen, setIsFormOpen] = useState(
    !!searchParams.get('template') || !!searchParams.get('topic'),
  );
  // Run the empty-history auto-open exactly once per page load — without
  // this guard, dismissing the modal would re-trigger it next render.
  const autoOpenedForFirstTimeUser = useRef(false);

  // Debate config (debaters, rounds, length, anonymity) sits behind a
  // "Settings" toggle so the modal isn't a wall of controls. Sensible
  // defaults handle most cases; the user opens this when they care.
  const [isConfigOpen, setIsConfigOpen] = useState(false);

  // Per-debater override: when a template prescribes a position, we hide
  // the position input and show the prescribed text as a caption. The
  // user can click "Edit position" to reveal the input for that one slot
  // — opting out of the template's framing for that debater only.
  const [editingPositionFor, setEditingPositionFor] = useState<Set<number>>(new Set());

  // --- Keyboard shortcut (Ctrl/Cmd+Enter to start) ---
  const generateRef = useRef<(() => void) | undefined>(undefined);
  generateRef.current = generateDebate;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        generateRef.current?.();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // --- Sample debate (hero empty state) ---
  const [sampleDebate, setSampleDebate] = useState<Debate | null>(null);
  useEffect(() => {
    if (!config.sampleDebateId) return;
    fetchDebateById(config.sampleDebateId).then(d => {
      if (d) setSampleDebate(d);
    });
  }, []);

  // --- Refs ---
  const debateEndRef = useRef<HTMLDivElement>(null);
  const debatePanelRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const argCountRef = useRef(0);

  // --- Derived ---
  // Open-access mode treats every visitor as logged-in for the purpose of
  // unlocking gated controls (rounds, extra debaters, premium models). The
  // account UI itself is hidden separately via config.openAccess.
  const effLoggedIn = isLoggedIn || config.openAccess;
  const canAddModel = debaters.length < 3;
  // True when at least one slot is a human player. Human debates run open-ended
  // up to 15 rounds; the user decides when to stop. AI-only debates use a fixed
  // round count chosen up front.
  const hasUserDebater = debaters.some(d => findModel(d.modelId)?.family === 'user');
  const HUMAN_DEBATE_MAX_ROUNDS = 15;
  // Effective rounds: AI-only debates use the picker value; human debates use the cap.
  const effectiveRounds = hasUserDebater ? HUMAN_DEBATE_MAX_ROUNDS : rounds;
  // Token cost for the full debate = rounds × sum of each debater's per-argument cost
  // (user slots have tokenCost: 0, so they don't contribute)
  const tokensPerRound = debaters.reduce((sum, d) => sum + getModelTokenCost(d.modelId), 0);
  const totalDebateCost = effectiveRounds * tokensPerRound;
  // Open-access mode disables token billing, so affordability never blocks.
  const canAffordFull = config.openAccess || tokenBalance === null || tokenBalance >= totalDebateCost;
  const canAffordAny = config.openAccess || tokenBalance === null || tokenBalance >= 1;
  // A debater is valid if they have a position OR they're set to auto-assign.
  // When a template is selected, also require its `required: true` fields.
  const templateValid = selectedTemplate
    ? templateFieldsFilled(selectedTemplate, templateFieldValues)
    : true;
  const isValid = topic.trim().length > 0 &&
    debaters.every(d => d.assignmentMode === 'auto' || d.position.trim().length > 0) &&
    debaters.length >= 2 &&
    templateValid;

  // True when the active template prescribes positions for both seats.
  // In that case, the per-debater position input and Auto toggle are
  // template-driven and should not be edited by the user — they'd be
  // overriding the template's framing.
  const templateLocksPositions = !!selectedTemplate
    && selectedTemplate.positions[0].trim().length > 0
    && selectedTemplate.positions[1].trim().length > 0;

  // Specific message for what's missing — surfaced beside/under the
  // submit button so a disabled CTA isn't a dead end.
  function getMissingMessage(): string | null {
    if (!topic.trim()) return 'Add a topic first.';
    if (selectedTemplate && !templateValid) {
      const missing = selectedTemplate.formFields.find((f) => {
        if (!f.required) return false;
        const v = templateFieldValues[f.id];
        if (f.kind === 'textarea') return !String(v ?? '').trim();
        if (f.kind === 'urlList') return !(Array.isArray(v) && (v as string[]).some((u) => u.trim()));
        if (f.kind === 'candidateList') {
          const min = f.minCandidates ?? 2;
          const filled = Array.isArray(v)
            ? (v as { name: string; summary: string }[]).filter((c) => c.name.trim() || c.summary.trim())
            : [];
          return filled.length < min;
        }
        return false;
      });
      if (missing) return `Add ${missing.label.toLowerCase()} first.`;
    }
    if (!templateLocksPositions
        && debaters.some((d) => d.assignmentMode !== 'auto' && !d.position.trim())) {
      return 'Add a position for each debater first.';
    }
    return null;
  }
  const missingMessage = !generating && !isValid ? getMissingMessage() : null;
  const hasDebate = activeDebate !== null;

  // ========================================================================
  // Auth & history
  // ========================================================================

  const loadTokenBalance = useCallback(async () => {
    const balance = await fetchTokenBalance();
    setTokenBalance(balance);
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const debates = await getUserDebates();
    setHistory(debates);
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    loadTokenBalance();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setIsLoggedIn(!!user);
      if (user) {
        setRounds(prev => prev === 3 ? 5 : prev);
        loadHistory();
        // Note: we deliberately do NOT auto-load any past debate on mount.
        // A page refresh starts on the empty form. Users resume past debates
        // by clicking them in the history sidebar.
      }
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsLoggedIn(!!session?.user);
      if (session?.user) {
        setRounds(prev => prev === 3 ? 5 : prev);
        loadHistory();
      } else {
        setHistory([]);
        setRounds(3);
      }
      loadTokenBalance();
    });
    const cleanupBalanceListener = onBalanceChanged(loadTokenBalance);
    return () => { subscription.unsubscribe(); cleanupBalanceListener(); };
  }, [loadHistory, loadTokenBalance]);

  // ========================================================================
  // Scrolling
  // ========================================================================

  useEffect(() => {
    const panel = debatePanelRef.current;
    if (!panel) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = panel;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 150;
    };
    panel.addEventListener('scroll', onScroll, { passive: true });
    return () => panel.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll to keep the cursor visible during token streaming.
  //
  // Two distinct scroll triggers:
  //   - New argument or thinking indicator → smooth scroll to bottom
  //     (one-shot, cosmetic animation as the next slot announces itself).
  //   - Token streaming inside the current argument → instant scroll to
  //     bottom on every token update. Instant avoids smooth-animation
  //     jank at ~30 token-updates/sec, and matches the natural "follow
  //     the cursor" feel.
  //
  // Both gated by isNearBottomRef so scrolling up to read history is not
  // interrupted by auto-scroll.
  //
  // We track the streaming arg's content length as an effect dependency
  // so the effect re-runs as the arg grows — without it, the effect only
  // fires when liveArguments.length changes (per-argument, not per-token).
  const streamingContentLength = liveArguments[liveArguments.length - 1]?.streaming
    ? liveArguments[liveArguments.length - 1].content.length
    : 0;

  useEffect(() => {
    const panel = debatePanelRef.current;
    if (!panel || !isNearBottomRef.current) return;

    const newCount = liveArguments.length;
    const isNew = newCount !== argCountRef.current;
    argCountRef.current = newCount;

    if (isNew || currentThinking) {
      // Smooth scroll for the cosmetic case (new bubble appearing).
      panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' });
    } else if (streamingContentLength > 0) {
      // Instant scroll to keep the cursor visible during streaming.
      panel.scrollTop = panel.scrollHeight;
    }
  }, [liveArguments.length, currentThinking, streamingContentLength]);

  // ========================================================================
  // React to orchestrator state transitions
  // ========================================================================

  // When the orchestrator finishes a debate, refresh history sidebar so the
  // newly completed debate appears at the top. The provider handles the DB
  // write itself; the page just reacts to the flag.
  useEffect(() => {
    if (justCompleted) {
      if (isLoggedIn) loadHistory();
      acknowledgeJustCompleted();
    }
  }, [justCompleted, isLoggedIn, loadHistory, acknowledgeJustCompleted]);

  // When the orchestrator surfaces an insufficient_tokens error, open the
  // buy/auth modal. The error itself stays on screen until cleared by the
  // user starting a new action.
  useEffect(() => {
    if (errorReason === 'insufficient_tokens') {
      if (isLoggedIn) setShowBuyTokens(true);
      else setShowAuth(true);
    }
  }, [errorReason, isLoggedIn]);

  // ========================================================================
  // Form helpers
  // ========================================================================

  function updateDebater(i: number, field: keyof DebaterConfig, value: string) {
    setDebaters(prev => {
      const updated = [...prev];
      updated[i] = { ...updated[i], [field]: value };
      // Switching to a user slot: clear any auto-assign mode (humans pick their own positions)
      if (field === 'modelId' && findModel(value)?.family === 'user') {
        updated[i].assignmentMode = 'manual';
      }
      return updated;
    });
  }

  function addDebater() {
    if (!canAddModel) return;
    // Default to a model not yet used (any tier), or fall back to the first model
    const usedIds = new Set(debaters.map(d => d.modelId));
    const unused = MODELS.find(m => !usedIds.has(m.id));
    setDebaters(prev => [...prev, { modelId: unused?.id || MODELS[0].id, position: '' }]);
  }

  function removeDebater(i: number) {
    if (debaters.length <= 2) return;
    setDebaters(prev => prev.filter((_, idx) => idx !== i));
  }

  function clearForm() {
    setTopic('');
    setContext('');
    setRevealIdentities(true);
    setResponseLength('detailed');
    setDebaters([
      { modelId: 'claude-sonnet', position: '' },
      { modelId: 'gpt-4o', position: '' },
    ]);
    setRounds(isLoggedIn ? 5 : 3);
    setSelectedTemplate(null);
    setTemplateFieldValues({});
  }

  // Apply a template to the form. Pre-fills positions, suggested rounds,
  // and resets the template-form values to empty defaults from the
  // template's schema. Does NOT pre-fill the topic — that's the user's
  // input, the placeholder changes to hint at what they might type.
  function applyTemplate(template: DebateTemplate) {
    setSelectedTemplate(template);
    setTemplateFieldValues(makeEmptyTemplateValues(template));
    setEditingPositionFor(new Set());
    setDebaters((prev) => {
      const next = [...prev];
      // Ensure at least 2 debater slots exist — templates are all 2-sided
      while (next.length < 2) {
        next.push({ modelId: 'claude-sonnet', position: '' });
      }
      next[0] = { ...next[0], position: template.positions[0], assignmentMode: 'manual' };
      next[1] = { ...next[1], position: template.positions[1], assignmentMode: 'manual' };
      return next;
    });
    // Legacy free-text context lives separately; reset it so the
    // template's structured fields are the source of truth.
    setContext('');
    // Logged-out users are capped at 3 rounds — clamp the template's
    // suggestion so the form can't end up in a "5 selected, but locked"
    // state that silently submits at 5. Logged-in users get the full
    // template suggestion (3 / 5 / 7).
    setRounds(isLoggedIn ? template.suggestedRounds : Math.min(template.suggestedRounds, 3));
  }

  function clearTemplate() {
    setSelectedTemplate(null);
    setTemplateFieldValues({});
    setEditingPositionFor(new Set());
    setContext('');
    setDebaters((prev) => prev.map((d) => ({ ...d, position: '' })));
  }

  // On first mount, if the URL carries ?template=<slug>, apply it
  // automatically so homepage entry points land directly on a
  // configured form.
  useEffect(() => {
    const slug = searchParams.get('template');
    if (!slug) return;
    const template = getTemplateBySlug(slug);
    if (template) applyTemplate(template);
    // Intentional: run once on mount. We don't want to re-apply when
    // searchParams change during client navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-time-user auto-open: once the history finishes loading for a
  // logged-in user, if they have no past debates and no active debate,
  // open the form modal. Runs at most once per page load — dismissing
  // the modal won't re-trigger it.
  useEffect(() => {
    if (autoOpenedForFirstTimeUser.current) return;
    if (!isLoggedIn) return;
    if (historyLoading) return;
    if (history.length > 0) {
      // Mark as "checked" so we don't keep watching for empty.
      autoOpenedForFirstTimeUser.current = true;
      return;
    }
    if (activeDebate) return;
    autoOpenedForFirstTimeUser.current = true;
    setIsFormOpen(true);
  }, [isLoggedIn, historyLoading, history.length, activeDebate]);

  // Hiring template: keep the debaters array in sync with the
  // candidate list. Each candidate maps to one debater seat — that's
  // the whole structural conceit of the hiring template (one model
  // arguing per candidate). Without this, a user could add 4
  // candidates and only 2 would actually be debated.
  useEffect(() => {
    if (selectedTemplate?.slug !== 'hiring-decision') return;
    const candidates = templateFieldValues.candidates as
      | Array<{ name: string; summary: string; url: string }>
      | undefined;
    if (!Array.isArray(candidates)) return;
    // Cap at 3 — current platform limit on debaters.
    const targetCount = Math.min(Math.max(candidates.length, 2), 3);
    setDebaters((prev) => {
      let next = [...prev];
      // Grow / shrink to match candidate count.
      while (next.length < targetCount) {
        next.push({ modelId: 'claude-sonnet', position: '', assignmentMode: 'manual' });
      }
      if (next.length > targetCount) {
        next = next.slice(0, targetCount);
      }
      // Refresh each debater's position from the matching candidate.
      // Format mirrors the serialiser ("Argue the case for Alex: ...")
      // so the model's prompt cleanly says what it's arguing.
      return next.map((d, i) => {
        const c = candidates[i];
        if (!c) return d;
        const label = c.name.trim() || `Candidate ${i + 1}`;
        const brief = c.summary.trim();
        const position = brief
          ? `Argue the case for ${label}: ${brief}`
          : `Argue the case for ${label}`;
        return { ...d, position, assignmentMode: 'manual' };
      });
    });
  }, [selectedTemplate, templateFieldValues.candidates]);

  // ========================================================================
  // View a saved debate (from history)
  // ========================================================================

  function viewSavedDebate(debate: Debate) {
    loadDebate(debate);
    setIsFormOpen(false);
    isNearBottomRef.current = false;
    setTimeout(() => {
      if (debatePanelRef.current) debatePanelRef.current.scrollTop = 0;
    }, 0);
  }

  // ========================================================================
  // Round-by-round orchestration
  // ========================================================================
  //
  // The actual orchestrator loop now lives in DebateOrchestratorProvider so
  // it survives in-app navigation. Everything below this comment used to be
  // orchestration logic — it has been moved out. The page now drives the
  // orchestrator via the actions hook (startDebate / continueDebate /
  // extendActiveDebate / submitUserTurn / loadDebate / resetDebate).
  // ========================================================================

  // (orchestrator lives in lib/orchestrator/DebateOrchestratorProvider.tsx)
  // The block formerly here — RunDebateConfig, RoundResult, runOneRound,
  // runDebate, promptUserTurn, handleUserSubmit, handleSSE — is gone.
  // Removed in commit 3 of the realtime orchestrator refactor.

  // (orchestrator moved to lib/orchestrator/DebateOrchestratorProvider.tsx)
  // The page calls submitUserTurn() directly via the actions hook — the
  // pending Promise resolver lives in the provider so the user-turn pause
  // survives navigation.
  const handleUserSubmit = submitUserTurn;

  // ========================================================================
  // Action wrappers — thin glue between page-local form/UI state and the
  // orchestrator provider. The provider does the actual work.
  // ========================================================================

  async function generateDebate() {
    if (!isValid || generating) return;

    // Capture the current form values (we clear the form right after, before
    // the orchestrator returns) and reset the scroll-anchor so new tokens
    // pin to the bottom.
    const debateTopic = topic;
    const debateDebaters = [...debaters];
    const debateRounds = effectiveRounds;
    // Compose the final context the models will see: template-form
    // values (Phase B) get serialised into a Markdown block, then the
    // legacy free-text context appended below for users who want to add
    // a note. Either may be empty.
    const serialisedTemplate = selectedTemplate
      ? serialiseTemplateValues(selectedTemplate, templateFieldValues)
      : '';
    const debateContext = [serialisedTemplate, context.trim()]
      .filter(Boolean)
      .join('\n\n');
    const debateReveal = revealIdentities;
    const debateResponseLength = responseLength;

    isNearBottomRef.current = true;
    argCountRef.current = 0;
    clearForm();
    // Close the form modal immediately — the debate panel behind it
    // will stream the first arguments within a second or two.
    setIsFormOpen(false);

    await startDebate({
      topic: debateTopic,
      debaters: debateDebaters,
      rounds: debateRounds,
      context: debateContext,
      revealIdentities: debateReveal,
      responseLength: debateResponseLength,
      templateSlug: selectedTemplate?.slug ?? null,
    });
  }

  // Page-local wrapper around the provider's continueDebate so the JSX can
  // keep its existing onClick reference name.
  const handleContinueDebate = continueDebate;

  // Page-local wrapper around extendActiveDebate. Returns the in-flight
  // promise so the modal can satisfy its onExtend: Promise<void> contract,
  // but the modal closes immediately and the rounds stream in the background.
  async function handleExtendDebate(extraRounds: number, moderatorNote: string) {
    await extendActiveDebate(extraRounds, moderatorNote);
  }

  async function toggleDebateVisibility(makePublic: boolean) {
    if (!activeDebate?.id) return;
    // Optimistic update via the provider
    updateActiveDebate({ isPublic: makePublic });
    try {
      const res = await fetch(`/api/debates/${activeDebate.id}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: makePublic }),
      });
      if (!res.ok) {
        // Revert on failure
        updateActiveDebate({ isPublic: !makePublic });
      }
    } catch {
      updateActiveDebate({ isPublic: !makePublic });
    }
  }

  // ========================================================================
  // Render helpers
  // ========================================================================

  const maxRound = liveArguments.length > 0 ? Math.max(...liveArguments.map(a => a.round)) : 0;
  // Look up the active debate's template (if any) so we can render
  // its per-template disclaimer above the arguments.
  const activeTemplate = activeDebate
    ? getTemplateBySlug(activeDebate.templateSlug ?? null)
    : null;
  const shareUrl = activeDebate?.id ? `${typeof window !== 'undefined' ? window.location.origin : ''}/journal/debate/${activeDebate.id}` : '';
  const activeDisplayNames = activeDebate ? getDisplayNames(activeDebate.debaters) : [];
  // The next debater needed if the debate is incomplete (used to adapt the
  // "Continue Debate" UI: hidden when the orchestrator is already running, and
  // re-worded when the next slot is a human player.)
  const nextDebater = (activeDebate && !activeDebate.isComplete && liveArguments.length > 0)
    ? findNextDebaterToArgue(activeDebate.debaters, liveArguments.filter(a => !a.streaming), activeDebate.rounds)
    : null;

  return (
    <div className={styles.page}>
      {/* ================================================================ */}
      {/* LEFT SIDEBAR: New debate button + history                        */}
      {/* ================================================================ */}
      <div className={`${styles.sidebar} ${hasDebate ? styles.sidebarHidden : ''}`}>
        <Link href="/journal/debates" className={styles.browseDebatesCta}>
          Browse debates
        </Link>
        <button
          type="button"
          className={styles.newDebateCta}
          onClick={() => setIsFormOpen(true)}
          disabled={generating}
        >
          + New debate
        </button>

        {/* Debate history */}
        {isLoggedIn && (historyLoading || history.length > 0) && (
          <div className={styles.historySection}>
            <div className={styles.historyHeader}>
              <span className={styles.label}>Your Debates</span>
            </div>
            {generating && (
              <p className={styles.historyDisabledNote}>
                Browsing other debates is disabled while one is running.
              </p>
            )}
            {historyLoading && history.length === 0 ? (
              <div className={styles.historyLoading}>
                <Loader2 size={16} className={styles.spinner} />
                <span>Loading debates...</span>
              </div>
            ) : (
            <div className={styles.historyList}>
              {history.map(debate => (
                <div
                  key={debate.id}
                  className={`${styles.historyItem} ${activeDebate?.id === debate.id ? styles.historyItemActive : ''} ${generating ? styles.historyItemDisabled : ''}`}
                  onClick={() => !generating && viewSavedDebate(debate)}
                >
                  {confirmDeleteId === debate.id ? (
                    <div className={styles.confirmDelete}>
                      <span>Delete this debate?</span>
                      <div className={styles.confirmDeleteActions}>
                        <button
                          className={styles.confirmYes}
                          onClick={e => {
                            e.stopPropagation();
                            deleteDebate(debate.id).then(ok => {
                              if (ok) {
                                loadHistory();
                                if (activeDebate?.id === debate.id) {
                                  resetDebate();
                                }
                              }
                              setConfirmDeleteId(null);
                            });
                          }}
                        >Delete</button>
                        <button
                          className={styles.confirmNo}
                          onClick={e => { e.stopPropagation(); setConfirmDeleteId(null); }}
                        >Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className={styles.historyItemRow}>
                        <span className={styles.historyTopic}>{debate.topic}</span>
                        <button
                          className={styles.historyDelete}
                          onClick={e => { e.stopPropagation(); setConfirmDeleteId(debate.id); }}
                          title="Delete debate"
                        ><X size={12} /></button>
                      </div>
                      <span className={styles.historyMeta}>
                        {debate.rounds}r · {debate.models.length}m · {new Date(debate.created_at).toLocaleDateString()}
                        {!debate.is_complete && ' · incomplete'}
                      </span>
                    </>
                  )}
                </div>
              ))}
            </div>
            )}
          </div>
        )}
      </div>

      {/* ================================================================ */}
      {/* FORM MODAL: overlays the page when open                          */}
      {/* ================================================================ */}
      {isFormOpen && (
      <div
        className={styles.formModalOverlay}
        onClick={() => { if (!generating) setIsFormOpen(false); }}
      >
      <div
        className={styles.formModal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <button
          type="button"
          className={styles.formModalClose}
          onClick={() => setIsFormOpen(false)}
          aria-label="Close"
          disabled={generating}
        >
          <X size={18} />
        </button>
      <div className={styles.formPanel}>
        {/* Modal header.
            - No template: "Start a debate" + helper line above the
              template grid.
            - Template selected: template icon + name + tagline acts as
              the heading, with a slim "Change template" affordance. */}
        {selectedTemplate ? (
          <div className={styles.modalHeader}>
            <div className={styles.modalHeaderRow}>
              <span className={styles.templateIcon}>
                <selectedTemplate.icon size={24} />
              </span>
              <div className={styles.modalHeaderText}>
                <h2 className={styles.modalTitle}>{selectedTemplate.name}</h2>
                <p className={styles.modalSubtitle}>{selectedTemplate.tagline}</p>
              </div>
              <button
                type="button"
                className={styles.changeTemplateLink}
                onClick={clearTemplate}
              >
                Change template
              </button>
            </div>
          </div>
        ) : (
          <div className={styles.modalHeader}>
            <h2 className={styles.modalTitle}>What kind of debate?</h2>
            <p className={styles.modalSubtitle}>
              Pick a template — that decides what the form looks like next. Use Open debate for free-form.
            </p>
          </div>
        )}

        {/* Step 1: templates grid. Selecting a template swaps the
            modal into step 2 (the form). Until then we show ONLY the
            grid — no half-visible form to clutter the choice. */}
        {!selectedTemplate && !generating && (
          <div className={styles.templatesSection}>
            <div className={styles.templatesGrid}>
              {DEBATE_TEMPLATES.map((t) => (
                <button
                  key={t.slug}
                  type="button"
                  className={styles.templateCard}
                  onClick={() => applyTemplate(t)}
                >
                  <span className={styles.templateCardIcon}>
                    <t.icon size={24} />
                  </span>
                  <div className={styles.templateBody}>
                    <div className={styles.templateName}>{t.name}</div>
                    <div className={styles.templateTagline}>{t.tagline}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: the form. Only rendered once a template is in play
            so the user makes the framing choice up front. */}
        {selectedTemplate && (
        <>
        <div className={styles.field}>
          <label className={styles.label}>
            {selectedTemplate?.topicLabel ?? 'What should they debate?'}
          </label>
          <input
            className={styles.topicInput}
            type="text"
            placeholder={selectedTemplate?.topicPlaceholder || "e.g. Is a banana a berry?"}
            maxLength={config.maxTopicLength}
            value={topic}
            onChange={e => setTopic(e.target.value)}
            disabled={generating}
          />
          {/* Starter topic chips — only useful for the open-debate
              template, where the user might be browsing for inspiration.
              Structured templates already have a precise placeholder
              that does this job. */}
          {!topic && !generating && selectedTemplate?.slug === 'open' && (
            <div className={styles.starterChips}>
              {STARTER_TOPICS.map(t => (
                <button
                  key={t}
                  type="button"
                  className={styles.starterChip}
                  onClick={() => setTopic(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Template-driven form fields (Phase B). When a template is
            selected, render the structured fields it asks for —
            product description, supporting URLs, candidate list, etc.
            Sits directly under the topic so the user fills the meat
            of their question first. The "Additional rules" textarea
            is the fallback when no template is selected. */}
        {selectedTemplate ? (
          <TemplateFormFields
            template={selectedTemplate}
            values={templateFieldValues}
            onChange={setTemplateFieldValues}
            isLoggedIn={effLoggedIn}
            onLoginRequired={() => setShowAuth(true)}
            disabled={generating}
          />
        ) : (
          <details className={styles.optionalSection}>
            <summary className={styles.optionalSummary}>
              <ChevronRight size={14} className={styles.detailsChevron} />
              Additional rules (optional)
            </summary>
            <div className={styles.optionalContent}>
              <textarea
                className={styles.textarea}
                placeholder="Rules or context, e.g. Scientific evidence only"
                maxLength={config.maxContextLength}
                value={context}
                onChange={e => setContext(e.target.value)}
                disabled={generating}
              />
            </div>
          </details>
        )}

        {/* ============================================================ */}
        {/* Debaters — visible. The model picker is too central a       */}
        {/* choice to hide behind a collapsible.                         */}
        {/* ============================================================ */}
        <div className={styles.field}>
          <label className={styles.label}>Who argues?</label>
          <div className={styles.debaterCards}>
            {debaters.map((debater, i) => (
              <div
                key={i}
                className={styles.debaterCard}
                style={{ '--debater-colour': getModelColour(debater.modelId) } as React.CSSProperties}
              >
                <div className={styles.debaterHeader}>
                  <div className={styles.modelDot} style={{ background: getModelColour(debater.modelId) }} />
                  <ModelSelect
                    value={debater.modelId}
                    onChange={id => updateDebater(i, 'modelId', id)}
                    disabled={generating}
                    isLoggedIn={effLoggedIn}
                    onPremiumLocked={() => setShowAuth(true)}
                  />
                  {debaters.length > 2 && !generating && (
                    <button className={styles.removeButton} onClick={() => removeDebater(i)}>
                      <X size={14} />
                    </button>
                  )}
                </div>
                {/* Position area. Three modes:
                    - Template locks positions AND user hasn't asked to
                      edit this one → show the prescribed position as a
                      muted caption with an "Edit" affordance.
                    - Otherwise → show the editable input + Auto toggle
                      (Auto only for AI debaters, never for user/template-
                      locked seats since those wouldn't make sense). */}
                {templateLocksPositions && !editingPositionFor.has(i) ? (
                  <div className={styles.positionLocked}>
                    <span className={styles.positionLockedText}>{debater.position}</span>
                    <button
                      type="button"
                      className={styles.positionEditLink}
                      onClick={() => setEditingPositionFor((prev) => new Set(prev).add(i))}
                      disabled={generating}
                    >
                      Edit
                    </button>
                  </div>
                ) : (
                  <div className={styles.positionRow}>
                    <input
                      className={styles.positionInput}
                      type="text"
                      placeholder={
                        findModel(debater.modelId)?.family === 'user'
                          ? 'Your position...'
                          : debater.assignmentMode === 'auto'
                            ? 'AI will pick its own stance'
                            : 'Their position...'
                      }
                      maxLength={config.maxPositionLength}
                      value={debater.assignmentMode === 'auto' ? '' : debater.position}
                      onChange={e => updateDebater(i, 'position', e.target.value)}
                      disabled={generating || debater.assignmentMode === 'auto'}
                    />
                    {findModel(debater.modelId)?.family !== 'user' && !templateLocksPositions && (
                      <button
                        type="button"
                        className={`${styles.autoToggle} ${debater.assignmentMode === 'auto' ? styles.autoToggleOn : ''}`}
                        onClick={() => {
                          if (generating) return;
                          setDebaters(prev => {
                            const updated = [...prev];
                            const newMode = updated[i].assignmentMode === 'auto' ? 'manual' : 'auto';
                            updated[i] = {
                              ...updated[i],
                              assignmentMode: newMode,
                              position: newMode === 'auto' ? '' : updated[i].position,
                            };
                            return updated;
                          });
                        }}
                        disabled={generating}
                        title="Let the AI pick its own stance"
                      >
                        Auto
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
            {canAddModel && !generating && (
              effLoggedIn ? (
                <button className={styles.addModel} onClick={addDebater}>+ Add model</button>
              ) : (
                <button className={styles.lockedOption} onClick={() => setShowAuth(true)}>
                  + Add model <span className={styles.lockedBadge}>Sign up</span>
                </button>
              )
            )}
          </div>
        </div>

        {/* ============================================================ */}
        {/* Advanced settings — collapsed. Holds rounds, response       */}
        {/* length, anonymity. Sensible defaults so most users never    */}
        {/* need to open this.                                           */}
        {/* ============================================================ */}
        <div className={styles.configSection}>
          <button
            type="button"
            className={styles.configSummary}
            onClick={() => setIsConfigOpen((v) => !v)}
            aria-expanded={isConfigOpen}
          >
            <ChevronRight
              size={14}
              className={`${styles.configChevron} ${isConfigOpen ? styles.configChevronOpen : ''}`}
            />
            <span className={styles.configSummaryLabel}>Advanced</span>
            <span className={styles.configSummaryValue}>
              {hasUserDebater ? `up to ${HUMAN_DEBATE_MAX_ROUNDS} rounds` : `${rounds} rounds`}
              <span className={styles.configSummarySep}> · </span>
              {responseLength}
              <span className={styles.configSummarySep}> · </span>
              {revealIdentities ? 'named' : 'anonymous'}
            </span>
            <span className={styles.configSummaryAction}>
              {isConfigOpen ? 'Done' : 'Edit'}
            </span>
          </button>

          {isConfigOpen && (
            <div className={styles.configBody}>
              <div className={styles.configRow}>
                {hasUserDebater ? (
                  <div className={styles.field}>
                    <label className={styles.label}>Rounds</label>
                    <p className={styles.humanRoundsNote}>
                      Up to {HUMAN_DEBATE_MAX_ROUNDS} — end any time on your turn.
                    </p>
                  </div>
                ) : (
                  <div className={styles.field}>
                    <label className={styles.label}>Rounds</label>
                    <div className={styles.roundSelector}>
                      {[3, 5, 7].map(n => {
                        const locked = !effLoggedIn && n > 3;
                        return (
                          <button
                            key={n}
                            className={`${styles.roundOption} ${rounds === n ? styles.roundOptionActive : ''} ${locked ? styles.roundOptionLocked : ''}`}
                            onClick={() => locked ? setShowAuth(true) : setRounds(n)}
                            disabled={generating}
                          >
                            {n}
                            {locked && <LockKeyhole size={12} className={styles.lockIcon} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className={styles.field}>
                  <label className={styles.label}>Response length</label>
                  <div className={styles.roundSelector}>
                    {(['concise', 'detailed'] as const).map(len => (
                      <button
                        key={len}
                        className={`${styles.roundOption} ${responseLength === len ? styles.roundOptionActive : ''}`}
                        onClick={() => setResponseLength(len)}
                        disabled={generating}
                      >
                        {len === 'concise' ? 'Concise' : 'Detailed'}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.field}>
                  <label className={styles.label}>Opponents</label>
                  <div className={styles.roundSelector}>
                    {(['named', 'anonymous'] as const).map(mode => (
                      <button
                        key={mode}
                        className={`${styles.roundOption} ${
                          (mode === 'named' ? revealIdentities : !revealIdentities)
                            ? styles.roundOptionActive : ''
                        }`}
                        onClick={() => !generating && setRevealIdentities(mode === 'named')}
                        disabled={generating}
                      >
                        {mode === 'named' ? 'Named' : 'Anonymous'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className={styles.submitRow}>
          <div className={styles.submitMeta}>
            {!config.openAccess && tokenBalance !== null && (
              <span className={styles.tokenBalance}>
                <span className={styles.tokenCount}>{tokenBalance}</span> tokens · this debate {totalDebateCost}
                {!canAffordAny && (
                  <button
                    className={styles.buyLink}
                    onClick={() => isLoggedIn ? setShowBuyTokens(true) : setShowAuth(true)}
                  >
                    {isLoggedIn ? 'Top up' : `Sign up for ${config.startingTokens} free`}
                  </button>
                )}
              </span>
            )}
            {missingMessage && (
              <span className={styles.missingHint}>{missingMessage}</span>
            )}
          </div>
          <button
            className={styles.submitButton}
            disabled={!isValid || generating || !canAffordAny}
            onClick={generateDebate}
          >
            {generating ? 'Debating…' : 'Start debate'}
          </button>
        </div>
        <p className={styles.privacyNote}>
          {config.openAccess ? (
            <>
              Debates are <strong>shareable by link</strong> — anyone with the URL can view.
            </>
          ) : isLoggedIn ? (
            <>
              Your debates are <strong>private by default</strong> — only you can see them, even with the URL. After it finishes you can choose to publish to the public feed.
            </>
          ) : (
            <>
              Anonymous debates are <strong>shareable by link</strong> — anyone with the URL can view. <button type="button" className={styles.privacyNoteLink} onClick={() => setShowAuth(true)}>Sign in</button> for private debates (owner-only, even with the URL).
            </>
          )}
        </p>
        <p className={styles.adviceNote}>
          Debates are AI-generated and a thinking tool, not professional advice. Decisions are yours. See <a href="/terms" target="_blank" rel="noopener noreferrer" className={styles.privacyNoteLink}>Terms</a>.
        </p>
        {isValid && canAffordAny && !canAffordFull && (
          <p className={styles.tokenWarning}>
            This debate costs {totalDebateCost} tokens but you have {tokenBalance}. It will stop when your tokens run out.
          </p>
        )}

        {error && <p className={styles.error}>{error}</p>}
        </>
        )}
      </div>
      </div>
      </div>
      )}

      {/* ================================================================ */}
      {/* RIGHT PANEL: Debate thread                                       */}
      {/* ================================================================ */}
      <div className={styles.debatePanel} ref={debatePanelRef}>
        {/* Mobile: back to form */}
        {hasDebate && !generating && (
          <button
            className={styles.mobileBackButton}
            onClick={() => { resetDebate(); setIsFormOpen(true); }}
          >
            <ChevronLeft size={16} /> New debate
          </button>
        )}

        {!hasDebate ? (
          <div className={styles.heroPanel}>
            <div className={styles.heroHeader}>
              <h2 className={styles.heroTitle}>
                Watch the models argue.
              </h2>
              <p className={styles.heroSubtitle}>
                <button
                  type="button"
                  className={styles.heroStartLink}
                  onClick={() => setIsFormOpen(true)}
                >
                  Start a debate
                </button>{' '}
                — or read this example to see how it works.
              </p>
            </div>

            {/* Sample debate rendered read-only. Falls back to text-only
                hero if the sample fails to load or isn't configured. */}
            {sampleDebate ? (() => {
              const samplePositions = sampleDebate.positions as Record<string, string>;
              const sampleArgs = sampleDebate.arguments as DebateArgument[];
              const sampleNames = getDisplayNames(
                sampleDebate.models.map((id, i) => ({
                  modelId: id,
                  position: samplePositions[String(i)] || '',
                }))
              );
              const sampleMaxRound = sampleArgs.length > 0
                ? Math.max(...sampleArgs.map(a => a.round)) : 0;

              return (
                <div className={styles.exampleContainer}>
                  <span className={styles.exampleBadge}>Example</span>

                  {/* Example header */}
                  <div className={styles.exampleHeader}>
                    <h3 className={styles.exampleTopic}>{sampleDebate.topic}</h3>
                    <div className={styles.exampleDebaters}>
                      {sampleDebate.models.map((modelId, i) => (
                        <span
                          key={i}
                          className={styles.exampleDebater}
                          style={{ color: getModelColour(modelId) }}
                        >
                          {sampleNames[i]}: {samplePositions[String(i)] || ''}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Example arguments — first round only to keep it compact */}
                  {sampleArgs
                    .filter(a => a.round === 1 && a.model_id !== 'moderator' && !a.refused)
                    .map((arg, i) => (
                      <div
                        key={i}
                        className={styles.argument}
                        style={{ '--model-colour': getModelColour(arg.model_id) } as React.CSSProperties}
                      >
                        <div className={styles.argumentHeader}>
                          <span className={styles.argumentModel}>{arg.model_name}</span>
                          <span className={styles.argumentPosition}>
                            {samplePositions[String(arg.debater_index)] || ''}
                          </span>
                        </div>
                        <div className={styles.argumentContent}>
                          <ReactMarkdown>{arg.content}</ReactMarkdown>
                        </div>
                      </div>
                    ))
                  }

                  {sampleMaxRound > 1 && (
                    <p className={styles.exampleMore}>
                      + {sampleMaxRound - 1} more {sampleMaxRound - 1 === 1 ? 'round' : 'rounds'} in the full debate
                    </p>
                  )}

                  <Link
                    href={`/journal/debate/${sampleDebate.id}`}
                    className={styles.exampleLink}
                  >
                    Read the full debate →
                  </Link>
                </div>
              );
            })() : (
              <p className={styles.heroSubtitle}>
                Claude, GPT-4o, and Gemini take sides on your topics. Vote on who made the better case.
              </p>
            )}

            {!isLoggedIn && !config.openAccess && (
              <div className={styles.heroSignup}>
                <button
                  className={styles.heroSignupButton}
                  onClick={() => setShowAuth(true)}
                >
                  Sign up for {config.startingTokens} free tokens
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className={styles.debateThread}>
            {/* Debate header */}
            <div className={styles.debateHeader}>
              {activeDebate.id && (
                <div className={styles.headerShareIcon}>
                  <ShareMenu
                    url={shareUrl}
                    title={`AI Debate: ${activeDebate.topic}`}
                    text={`Watch ${formatModelList(activeDebate.debaters)} debate: "${activeDebate.topic}"`}
                    variant="icon"
                  />
                </div>
              )}
              <h2 className={styles.debateTitle}>{activeDebate.topic}</h2>
              <div className={styles.debatePrivacyBadge}>
                {activeDebate.isPublic ? (
                  <>
                    <span className={styles.privacyBadgeDot} data-state="public" />
                    Public · listed on the public feed
                  </>
                ) : (
                  <>
                    <span className={styles.privacyBadgeDot} data-state="private" />
                    Private · only you can see this
                  </>
                )}
              </div>
              <div className={styles.debatePositions}>
                {activeDebate.debaters.map((d, i) => {
                  const version = findModel(d.modelId)?.version;
                  return (
                    <span
                      key={i}
                      className={styles.debatePosition}
                      style={{ color: getModelColour(d.modelId) }}
                    >
                      {activeDisplayNames[i]}
                      {version && <span className={styles.debaterVersion}> {version}</span>}
                      : {d.position}
                    </span>
                  );
                })}
              </div>
            </div>

            {/* Per-template disclaimer (e.g. hiring). Sits between the
                debate header and the first round so the reader sees the
                framing before the arguments. */}
            {activeTemplate?.disclaimer && (
              <div className={styles.templateDisclaimer} role="note">
                <strong>Heads up:</strong> {activeTemplate.disclaimer}
              </div>
            )}

            {/* Arguments by round */}
            {Array.from(new Set(liveArguments.map(a => a.round))).map(roundNum => (
              <div key={roundNum}>
                <div className={styles.roundDivider}>
                  <span className={styles.roundLabel}>
                    {roundNum === 1 ? 'Opening Statements'
                      : roundNum === maxRound && activeDebate.isComplete ? 'Closing Statements'
                      : `Round ${roundNum}`}
                  </span>
                </div>
                {liveArguments.filter(a => a.round === roundNum).map((arg, i) => {
                  // Moderator notes render as a centred italic interjection,
                  // visually distinct from debater argument cards.
                  if (arg.model_id === 'moderator') {
                    return (
                      <div
                        key={`${roundNum}-mod-${i}`}
                        className={styles.moderatorNote}
                      >
                        <span className={styles.moderatorLabel}>Moderator note</span>
                        <p className={styles.moderatorText}>{arg.content}</p>
                      </div>
                    );
                  }
                  return (
                    <div
                      key={`${roundNum}-${arg.debater_index}-${i}`}
                      className={`${styles.argument} ${arg.streaming ? styles.streaming : ''}`}
                      style={{ '--model-colour': getModelColour(arg.model_id) } as React.CSSProperties}
                    >
                      <div className={styles.argumentHeader}>
                        <span className={styles.argumentModel}>{arg.model_name}</span>
                        <span className={styles.argumentPosition}>
                          {activeDebate.debaters[arg.debater_index]?.position}
                        </span>
                        {arg.refused && <span className={styles.notChargedBadge}>Not charged</span>}
                        {arg.streaming && <span className={styles.streamingDot} />}
                      </div>
                      {arg.refused && arg.refusal_reason?.startsWith('API error:') ? (
                        <p className={styles.modelError}>
                          This model failed to respond. The debate continued without it.
                        </p>
                      ) : arg.refused ? (
                        <p className={styles.refusal}>
                          Declined this position{arg.refusal_reason ? `: ${arg.refusal_reason}` : ''}
                        </p>
                      ) : (
                        <div className={styles.argumentContent}>
                          <ReactMarkdown>{arg.content}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}

            {/* Thinking indicator */}
            {currentThinking && (
              <div className={styles.thinkingIndicator}>
                <Loader2 size={16} className={styles.spinner} />
                {currentThinking} is thinking...
              </div>
            )}

            {/* Pre-first-event indicator. Between submitting the round POST
                and the first SSE event arriving, the server is doing
                potentially-slow setup work — auto-assigning positions for
                'auto' debaters (one model API call each) and the topic
                safety check. Without this, the debate area sits silent for
                several seconds. */}
            {generating && !currentThinking && liveArguments.length === 0 && (
              <div className={styles.thinkingIndicator}>
                <Loader2 size={16} className={styles.spinner} />
                {activeDebate?.debaters.some(d => d.assignmentMode === 'auto')
                  ? 'Choosing positions...'
                  : 'Preparing debate...'}
              </div>
            )}

            {/* User-turn input — appears when THIS tab's orchestrator hit a
                human-turn pause. Hidden in follower mode (the driver tab
                shows the input; this tab is read-only). */}
            {pendingUserTurn && !isFollowing && (
              <UserTurnInput
                displayName={pendingUserTurn.displayName}
                position={pendingUserTurn.position}
                colour={getModelColour('user')}
                isLastInRound={pendingUserTurn.isLastInRound}
                onSubmit={handleUserSubmit}
              />
            )}

            {/* Follower-mode banner: this debate is being driven in another
                tab. Arguments arrive live via the Realtime subscription. */}
            {isFollowing && (
              <div className={styles.followerBanner}>
                <Loader2 size={14} className={styles.spinner} />
                <span>
                  {dbAwaitingHuman
                    ? 'Live — another tab is on a human turn.'
                    : 'Live — driven from another tab.'}
                </span>
              </div>
            )}

            {/* Take-over button. Visibility is governed by canTakeOver from
                the provider — true only when status is awaiting_human (any
                time) OR the driver lease has gone stale. Hidden during active
                streaming with a fresh heartbeat per Q1 of the refactor plan. */}
            {canTakeOver && (
              <div className={styles.takeOver}>
                <p className={styles.continueText}>
                  {dbDriverStale
                    ? "The other tab isn't responding."
                    : dbAwaitingHuman
                      ? "It's your turn — currently awaiting input in another tab."
                      : 'Take over this debate.'}
                </p>
                <button
                  className={styles.submitButton}
                  onClick={async () => {
                    const result = await takeOverDebate();
                    if (!result.ok) {
                      // Error already surfaced via the provider's error state.
                    }
                  }}
                >
                  {dbDriverStale ? 'Take over' : 'Take over'}
                </button>
                {error && <p className={styles.error}>{error}</p>}
              </div>
            )}

            {/* Continue incomplete debate.
                Hidden when the orchestrator is generating OR when a user input
                is already pending OR when another tab is driving. */}
            {activeDebate && !activeDebate.isComplete && !generating && !pendingUserTurn && !isFollowing && liveArguments.length > 0 && (
              <div className={styles.continueDebate}>
                <p className={styles.continueText}>
                  {nextDebater?.isUser
                    ? "It's your turn to argue."
                    : `This debate was interrupted — ${liveArguments.length} arguments completed.`}
                </p>
                <button className={styles.submitButton} onClick={() => void handleContinueDebate()}>
                  {nextDebater?.isUser ? 'Take Your Turn' : 'Continue Debate'}
                </button>
                {/* Inline error from the orchestrator (e.g. "this debate is
                    being driven in another tab"). The form panel is hidden
                    when a debate is loaded, so its own error block is
                    invisible — show it here too. */}
                {error && <p className={styles.error}>{error}</p>}
              </div>
            )}

            {/* Post-debate actions */}
            {activeDebate.isComplete && !generating && (
              <div className={styles.postDebate}>
                <span className={styles.postDebateText}>
                  {liveArguments.every(a => a.refused)
                    ? 'All models declined their assigned positions. Try different positions or a different topic.'
                    : `Debate complete — ${maxRound} rounds, ${liveArguments.length} arguments`}
                </span>

                {!isLoggedIn && !config.openAccess && (
                  <div className={styles.signupPrompt}>
                    <span className={styles.signupPromptTitle}>
                      Sign up to save debates and get {config.startingTokens} free tokens
                    </span>
                    <span className={styles.signupPromptDetail}>
                      This debate expires in 30 days without an account.
                    </span>
                    <button className={styles.signupButton} onClick={() => setShowAuth(true)}>
                      Create Free Account
                    </button>
                  </div>
                )}

                {activeDebate.id && !liveArguments.every(a => a.refused) && (
                  <VotingPanel
                    contentId={activeDebate.id}
                    contentType="debate"
                    options={activeDebate.debaters.map((d, i): VoteOption => ({
                      id: String(i),
                      name: `${activeDisplayNames[i]} — ${d.position}`,
                      colour: getModelColour(d.modelId),
                    }))}
                  />
                )}

                {activeDebate.rounds < 15 && !liveArguments.every(a => a.refused) && (
                  <button
                    className={styles.extendButton}
                    onClick={() => setShowExtendModal(true)}
                  >
                    Extend This Debate
                  </button>
                )}

                {activeDebate.id && (
                  <button className={styles.shareButton} onClick={() => setShowShareModal(true)}>
                    Share This Debate
                  </button>
                )}

                {isLoggedIn && activeDebate.id && !liveArguments.every(a => a.refused) && (
                  <div className={`${styles.publicToggleRow} ${!activeDebate.isPublic ? styles.publicToggleRowOff : ''}`}>
                    <div className={styles.publicToggleText}>
                      <span className={styles.publicToggleLabel}>
                        {activeDebate.isPublic
                          ? 'Public — listed in the public feed'
                          : 'Private — only you can see this'}
                      </span>
                      <span className={styles.publicToggleDescription}>
                        {activeDebate.isPublic
                          ? 'Anyone browsing the public debates feed can find it. Flip the switch off to unlist.'
                          : 'Debates are private by default. Flip the switch on to publish to the public feed.'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`${styles.switch} ${activeDebate.isPublic ? styles.switchOn : ''}`}
                      onClick={() => toggleDebateVisibility(!activeDebate.isPublic)}
                      aria-label={activeDebate.isPublic ? 'Unlist from the public feed' : 'Publish to the public feed'}
                    >
                      <span className={styles.switchKnob} />
                    </button>
                  </div>
                )}

                <div className={styles.postDebateActions}>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => {
                      const text = liveArguments
                        .map(a => `**${a.model_name}** (Round ${a.round}):\n${a.content}`)
                        .join('\n\n---\n\n');
                      navigator.clipboard.writeText(`# ${activeDebate.topic}\n\n${text}`);
                    }}
                  >Copy Text</button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => {
                      setTopic(activeDebate.topic);
                      setDebaters([...activeDebate.debaters]);
                      setRounds(activeDebate.rounds);
                      setContext(activeDebate.context || '');
                    }}
                  >Run Again</button>
                </div>

                {/* Decision synthesis — v3 utility pivot Phase 3.
                    Renders below the debate's post-completion actions.
                    Only appears for owners of completed debates. The
                    component auto-triggers synthesis generation on mount
                    if one doesn't exist yet. */}
                {isLoggedIn && activeDebate.id && !liveArguments.every(a => a.refused) && (
                  <DecisionSynthesis
                    debateId={activeDebate.id}
                    isOwner={true}
                    initialSynthesis={null}
                    initialWhatWouldChangeMyMind={null}
                    initialUserDecision={null}
                  />
                )}
              </div>
            )}

            <div ref={debateEndRef} />
          </div>
        )}
      </div>

      {/* Modals */}
      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onSuccess={() => setShowAuth(false)}
          initialMode="signup"
          message="Sign up to save this debate permanently"
        />
      )}

      {showShareModal && activeDebate?.id && (
        <ShareModal
          url={shareUrl}
          topic={activeDebate.topic}
          modelNames={activeDisplayNames}
          onClose={() => setShowShareModal(false)}
          // Only logged-in owners with non-all-refused debates can change
          // visibility — same gating as the in-arena toggle.
          isPublic={
            isLoggedIn && !liveArguments.every(a => a.refused)
              ? !!activeDebate.isPublic
              : undefined
          }
          onTogglePublic={
            isLoggedIn && !liveArguments.every(a => a.refused)
              ? toggleDebateVisibility
              : undefined
          }
        />
      )}

      {showBuyTokens && (
        <BuyTokensModal
          onClose={() => setShowBuyTokens(false)}
          onSuccess={() => { loadTokenBalance(); notifyBalanceChanged(); setShowBuyTokens(false); }}
        />
      )}

      {showExtendModal && activeDebate && (
        <ExtendDebateModal
          currentRounds={activeDebate.rounds}
          tokensPerRound={activeDebate.debaters.reduce((sum, d) => sum + getModelTokenCost(d.modelId), 0)}
          tokenBalance={tokenBalance}
          hasUserDebater={activeDebate.debaters.some(d => findModel(d.modelId)?.family === 'user')}
          onClose={() => setShowExtendModal(false)}
          onExtend={handleExtendDebate}
        />
      )}
    </div>
  );
}
