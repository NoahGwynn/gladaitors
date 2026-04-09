// ============================================================================
// Debate Arena — /arena/debate
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
import ReactMarkdown from 'react-markdown';
import { config } from '@/lib/config';
import {
  createDebateRecord, completeDebate, extendDebate,
  getUserDebates, deleteDebate, getSessionId,
} from '@/lib/debates';
import { fetchTokenBalance, notifyBalanceChanged, onBalanceChanged } from '@/lib/tokens';
import { createClient } from '@/lib/supabase';
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

interface DebaterConfig {
  modelId: string;
  position: string;
  /** 'manual' = user typed the position; 'auto' = AI picks its own stance on the first round */
  assignmentMode?: 'manual' | 'auto';
}

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

interface LiveArgument extends DebateArgument {
  streaming: boolean;
}

/** Metadata for the debate currently displayed in the right panel */
interface ActiveDebate {
  id: string | null;
  topic: string;
  debaters: DebaterConfig[];
  rounds: number;
  context?: string;
  isComplete: boolean;
  isPublic?: boolean;
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

  // --- Form state (left panel only) ---
  const [topic, setTopic] = useState(searchParams.get('topic') || '');
  const [debaters, setDebaters] = useState<DebaterConfig[]>([
    { modelId: 'claude-sonnet', position: '' },
    { modelId: 'gpt-4o', position: '' },
  ]);
  const [rounds, setRounds] = useState(3);
  const [context, setContext] = useState('');
  const [revealIdentities, setRevealIdentities] = useState(true);

  // --- Debate state (right panel) ---
  const [activeDebate, setActiveDebate] = useState<ActiveDebate | null>(null);
  const [liveArguments, setLiveArguments] = useState<LiveArgument[]>([]);
  const [generating, setGenerating] = useState(false);
  const [currentThinking, setCurrentThinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeRoundRef = useRef(1);
  const debateIdRef = useRef<string | null>(null);

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

  // --- Pending user turn (when a 'user' debater needs to type their argument) ---
  const [pendingUserTurn, setPendingUserTurn] = useState<{
    debaterIndex: number;
    displayName: string;
    position: string;
    round: number;
    isLastInRound: boolean;
  } | null>(null);
  // The orchestrator awaits this resolver. The user's submit handler resolves
  // it with one of:
  //   { kind: 'submitted', arg } — continue the debate normally
  //   { kind: 'ended',     arg } — submit this as the final user turn, then stop
  //   null                       — abandoned (page closed, etc); debate stays incomplete
  type UserTurnResult =
    | { kind: 'submitted'; arg: DebateArgument }
    | { kind: 'ended'; arg: DebateArgument };
  const userTurnResolverRef = useRef<((result: UserTurnResult | null) => void) | null>(null);

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

  // --- Refs ---
  const debateEndRef = useRef<HTMLDivElement>(null);
  const debatePanelRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);
  const argCountRef = useRef(0);

  // --- Derived ---
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
  const canAffordFull = tokenBalance === null || tokenBalance >= totalDebateCost;
  const canAffordAny = tokenBalance === null || tokenBalance >= 1;
  // A debater is valid if they have a position OR they're set to auto-assign
  const isValid = topic.trim().length > 0 &&
    debaters.every(d => d.assignmentMode === 'auto' || d.position.trim().length > 0) &&
    debaters.length >= 2;
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

  useEffect(() => {
    const newCount = liveArguments.length;
    const isNew = newCount !== argCountRef.current;
    argCountRef.current = newCount;
    if ((isNew || currentThinking) && isNearBottomRef.current && debateEndRef.current) {
      debateEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveArguments.length, currentThinking]);

  // ========================================================================
  // Mark debate complete when finished (only for debates we generated)
  // ========================================================================

  const justCompletedRef = useRef(false);
  useEffect(() => {
    if (activeDebate?.isComplete && generating === false && justCompletedRef.current) {
      justCompletedRef.current = false;
      // The server marks is_complete=true on the natural-end path (final
      // round completed), but the early-end path (user clicked "End debate"
      // before the final round) only happens client-side. Calling
      // completeDebate here is idempotent and covers both cases.
      if (debateIdRef.current) {
        completeDebate(debateIdRef.current).then(() => {
          if (isLoggedIn) loadHistory();
        });
      }
    }
  }, [activeDebate?.isComplete, generating]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setDebaters([
      { modelId: 'claude-sonnet', position: '' },
      { modelId: 'gpt-4o', position: '' },
    ]);
    setRounds(isLoggedIn ? 5 : 3);
  }

  // ========================================================================
  // View a saved debate (from history)
  // ========================================================================

  function viewSavedDebate(debate: Debate) {
    const positions = debate.positions as Record<string, string>;
    const debateDebaters = debate.models.map((id, i) => ({
      modelId: id,
      position: positions[String(i)] || '',
    }));

    setActiveDebate({
      id: debate.id,
      topic: debate.topic,
      debaters: debateDebaters,
      rounds: debate.rounds,
      context: debate.context,
      isComplete: debate.is_complete,
      isPublic: debate.is_public ?? false,
    });
    debateIdRef.current = debate.id;

    const args = debate.arguments as Array<DebateArgument>;
    setLiveArguments(args.map(a => ({ ...a, streaming: false })));
    setGenerating(false);
    setCurrentThinking(null);
    setError(null);
    setPendingUserTurn(null);
    userTurnResolverRef.current = null;
    isNearBottomRef.current = false;

    setTimeout(() => {
      if (debatePanelRef.current) debatePanelRef.current.scrollTop = 0;
    }, 0);
  }

  // ========================================================================
  // Round-by-round orchestration
  // ========================================================================
  //
  // The API runs ONE round per call. The frontend loops rounds, calling the
  // API once per round and accumulating arguments locally so each call has
  // the full prior context.
  //
  // Completion is set by the orchestrator when the loop ends naturally —
  // not by an SSE event. If `insufficient_tokens` fires mid-round, the loop
  // stops and the debate stays incomplete (so it can be resumed after top-up).
  // ========================================================================

  interface RunDebateConfig {
    topic: string;
    debaters: DebaterConfig[];
    rounds: number;
    context: string;
    revealIdentities: boolean;
    initialArgs: DebateArgument[];
    startRound: number;
    /** Set true on the very first call of a brand-new debate so we delete the empty record on safety/auth failure. */
    isNewDebate: boolean;
  }

  interface RoundResult {
    newArgs: DebateArgument[];
    insufficientTokens: boolean;
    error: string | null;
    /** If set, the API stopped because a user slot needs input. */
    userTurnNeeded: {
      debaterIndex: number;
      displayName: string;
      position: string;
      round: number;
    } | null;
  }

  async function runOneRound(
    config: RunDebateConfig,
    existingArguments: DebateArgument[],
    currentRound: number,
  ): Promise<RoundResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const sid = getSessionId();
    if (sid) headers['x-session-id'] = sid;

    const res = await fetch('/api/debate', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic: config.topic,
        debaters: config.debaters,
        rounds: config.rounds,
        currentRound,
        context: config.context || undefined,
        revealIdentities: config.revealIdentities,
        existingArguments,
        debateId: debateIdRef.current || undefined,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      let message = 'Something went wrong';
      try { message = JSON.parse(text).error || message; } catch { message = text || message; }
      const isInsufficient = res.status === 402;
      return { newArgs: [], insufficientTokens: isInsufficient, error: message, userTurnNeeded: null };
    }

    const reader = res.body?.getReader();
    if (!reader) {
      return { newArgs: [], insufficientTokens: false, error: 'No response stream', userTurnNeeded: null };
    }

    const newArgs: DebateArgument[] = [];
    let insufficientTokens = false;
    let userTurnNeeded: RoundResult['userTurnNeeded'] = null;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      let eventType = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ') && eventType) {
          try {
            const data = JSON.parse(line.slice(6));
            handleSSE(eventType, data);
            // Track results locally for the orchestrator
            if (eventType === 'argument') {
              newArgs.push(data as DebateArgument);
            } else if (eventType === 'insufficient_tokens') {
              insufficientTokens = true;
            } else if (eventType === 'user_turn_needed') {
              userTurnNeeded = {
                debaterIndex: data.debater_index as number,
                displayName: data.model_name as string,
                position: data.position as string,
                round: data.round as number,
              };
            }
          } catch { /* skip malformed */ }
          eventType = '';
        }
      }
    }

    return { newArgs, insufficientTokens, error: null, userTurnNeeded };
  }

  async function runDebate(config: RunDebateConfig) {
    setGenerating(true);
    setError(null);
    setCurrentThinking(null);
    isNearBottomRef.current = true;

    const allArgs: DebateArgument[] = [...config.initialArgs];
    let currentRound = config.startRound;

    // Set when the user explicitly chooses to end the debate. The orchestrator
    // lets the current round finish (so all debaters have the same number of
    // arguments), then breaks out of the outer loop and marks complete.
    let endRequested = false;

    try {
      outer: while (currentRound <= config.rounds) {
        // A single round may require MULTIPLE API calls if there are user slots
        // mid-round. Each call runs as much as it can; when it hits a user slot
        // (without an injected argument), it stops and we collect input from the
        // user, then re-call the same round to continue.
        let roundDone = false;
        while (!roundDone) {
          const result = await runOneRound(config, allArgs, currentRound);

          if (result.error) {
            // First-round failure on a brand-new debate: clean up the empty record
            if (config.isNewDebate && currentRound === config.startRound && allArgs.length === 0) {
              if (debateIdRef.current) {
                deleteDebate(debateIdRef.current);
                debateIdRef.current = null;
              }
              setActiveDebate(null);
            }
            if (result.insufficientTokens) {
              if (isLoggedIn) setShowBuyTokens(true);
              else setShowAuth(true);
            }
            setError(result.error);
            return;
          }

          if (result.insufficientTokens) {
            // SSE handler already opened the buy/auth modal and set the error.
            // Stop the loop so the debate stays incomplete.
            return;
          }

          allArgs.push(...result.newArgs);

          if (result.userTurnNeeded) {
            // The API stopped at a user slot. Collect input from the user, then
            // re-call the same round so the API can continue past this slot.
            const isLastInRound = result.userTurnNeeded.debaterIndex === config.debaters.length - 1;
            const userResult = await promptUserTurn(result.userTurnNeeded, isLastInRound);
            if (!userResult) {
              // User cancelled / orchestrator was reset. Stop cleanly — debate
              // stays incomplete and can be resumed.
              return;
            }
            allArgs.push(userResult.arg);
            // The user's argument is sent to the server in the next round
            // POST as part of `existingArguments`; the server merges and
            // persists it before generating the next AI argument. No client
            // write needed.
            if (userResult.kind === 'ended') {
              endRequested = true;
              // If the user was the last debater in the round, the round is
              // already done — break out immediately. Otherwise let the inner
              // loop continue so the API runs the remaining AI debaters before
              // we mark the debate complete (no lopsided rounds).
              if (isLastInRound) {
                roundDone = true;
              }
              // else: continue inner loop, API will fill in the rest of the round
            }
            // else (kind === 'submitted'): just loop and re-call the API for the same round
          } else {
            // round_complete (or stream closed cleanly) — advance to the next round.
            roundDone = true;
          }
        }

        if (endRequested) break outer;

        currentRound++;
        loadTokenBalance();
      }

      // Either all rounds completed naturally, or the user explicitly ended
      // the debate after the current round finished. The server marked
      // is_complete=true on the final round_complete; the useEffect on
      // (activeDebate.isComplete + justCompletedRef) just refreshes the
      // sidebar history.
      justCompletedRef.current = true;
      setActiveDebate(prev => prev ? { ...prev, isComplete: true } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setGenerating(false);
      setCurrentThinking(null);
      setPendingUserTurn(null);
      userTurnResolverRef.current = null;
      loadTokenBalance();
      notifyBalanceChanged();
    }
  }

  // ========================================================================
  // User-turn prompt — pause the orchestrator until the user submits
  // ========================================================================

  function promptUserTurn(
    turn: NonNullable<RoundResult['userTurnNeeded']>,
    isLastInRound: boolean,
  ): Promise<UserTurnResult | null> {
    return new Promise(resolve => {
      setPendingUserTurn({ ...turn, isLastInRound });
      userTurnResolverRef.current = resolve;
    });
  }

  /**
   * Called by UserTurnInput's submit handler. Runs the safety check, and if it
   * passes, builds a DebateArgument from the user's text and resolves the
   * pending promise so the orchestrator continues.
   *
   * `intent` tells the orchestrator whether to continue the debate ('continue')
   * or stop after this round ('end').
   */
  async function handleUserSubmit(
    text: string,
    intent: 'continue' | 'end',
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!pendingUserTurn) return { ok: false, error: 'No pending turn' };

    // Safety check
    const res = await fetch('/api/debate/check-argument', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      return { ok: false, error: 'Safety check failed. Please try again.' };
    }
    const { safe } = await res.json();
    if (!safe) {
      return { ok: false, error: 'This argument violates our usage policy. Please rewrite and try again.' };
    }

    // Build the synthetic argument
    const arg: DebateArgument = {
      debater_index: pendingUserTurn.debaterIndex,
      model_id: 'user',
      model_name: pendingUserTurn.displayName,
      round: pendingUserTurn.round,
      content: text,
      refused: false,
    };

    // Push it into liveArguments so it appears in the thread immediately
    setLiveArguments(prev => [...prev, { ...arg, streaming: false }]);

    // Resolve the orchestrator's promise — the inner loop will continue
    setPendingUserTurn(null);
    const resolver = userTurnResolverRef.current;
    userTurnResolverRef.current = null;
    if (resolver) {
      resolver(intent === 'end' ? { kind: 'ended', arg } : { kind: 'submitted', arg });
    }

    return { ok: true };
  }

  // ========================================================================
  // Generate a new debate (wrapper around runDebate)
  // ========================================================================

  async function generateDebate() {
    if (!isValid || generating) return;

    // Capture form values before clearing
    const debateTopic = topic;
    const debateDebaters = [...debaters];
    // Human debates use the open-ended cap; AI-only debates use the picker value
    const debateRounds = effectiveRounds;
    const debateContext = context;
    const debateReveal = revealIdentities;

    // Reset state for the new debate
    setActiveDebate({
      id: null,
      topic: debateTopic,
      debaters: debateDebaters,
      rounds: debateRounds,
      context: debateContext,
      isComplete: false,
    });
    setLiveArguments([]);
    setPendingUserTurn(null);
    userTurnResolverRef.current = null;
    debateIdRef.current = null;
    activeRoundRef.current = 1;
    argCountRef.current = 0;

    // Clear form for next debate
    clearForm();

    // Create the database record up-front (positions keyed by index)
    const positions: Record<string, string> = {};
    debateDebaters.forEach((d, i) => { positions[String(i)] = d.position; });
    const newId = await createDebateRecord({
      topic: debateTopic,
      positions,
      models: debateDebaters.map(d => d.modelId),
      rounds: debateRounds,
      context: debateContext || undefined,
    });
    if (newId) {
      debateIdRef.current = newId;
      setActiveDebate(prev => prev ? { ...prev, id: newId } : prev);
    }

    await runDebate({
      topic: debateTopic,
      debaters: debateDebaters,
      rounds: debateRounds,
      context: debateContext,
      revealIdentities: debateReveal,
      initialArgs: [],
      startRound: 1,
      isNewDebate: true,
    });
  }

  // ========================================================================
  // Continue an incomplete debate (wrapper around runDebate)
  // ========================================================================

  async function continueDebate() {
    if (!activeDebate || generating || activeDebate.isComplete) return;

    // Build the prior-arguments list (drop streaming placeholders)
    const existingArgs: DebateArgument[] = liveArguments.filter(a => !a.streaming).map(a => ({
      debater_index: a.debater_index,
      model_id: a.model_id,
      model_name: a.model_name,
      round: a.round,
      content: a.content,
      refused: a.refused,
      refusal_reason: a.refusal_reason,
    }));

    // Find the first round where not all debaters have argued — that's the resume point.
    // Moderator notes (model_id === 'moderator') are ignored when counting; they aren't
    // debater turns.
    let resumeRound = activeDebate.rounds + 1;
    for (let r = 1; r <= activeDebate.rounds; r++) {
      const argsInRound = existingArgs.filter(a => a.round === r && a.model_id !== 'moderator').length;
      if (argsInRound < activeDebate.debaters.length) {
        resumeRound = r;
        break;
      }
    }

    if (resumeRound > activeDebate.rounds) {
      // Already complete — nothing to do
      return;
    }

    await runDebate({
      topic: activeDebate.topic,
      debaters: activeDebate.debaters,
      rounds: activeDebate.rounds,
      context: activeDebate.context || '',
      // revealIdentities is not stored on the debate record — defaults to true on resume.
      // Pre-existing limitation; storing it is a separate concern.
      revealIdentities: true,
      initialArgs: existingArgs,
      startRound: resumeRound,
      isNewDebate: false,
    });
  }

  // ========================================================================
  // Extend a completed debate (add more rounds + optional moderator note)
  // ========================================================================

  async function handleExtendDebate(extraRounds: number, moderatorNote: string) {
    if (!activeDebate || !debateIdRef.current) return;

    const newTotalRounds = activeDebate.rounds + extraRounds;
    const firstNewRound = activeDebate.rounds + 1;

    // Build the updated arguments list. If the user typed a moderator note, append
    // it as a special argument tagged for the first new round so it shows up in
    // the AI prompts before the next debater speaks.
    const existingArgs: DebateArgument[] = liveArguments.filter(a => !a.streaming).map(a => ({
      debater_index: a.debater_index,
      model_id: a.model_id,
      model_name: a.model_name,
      round: a.round,
      content: a.content,
      refused: a.refused,
      refusal_reason: a.refusal_reason,
    }));

    if (moderatorNote) {
      existingArgs.push({
        debater_index: -1,
        model_id: 'moderator',
        model_name: 'Moderator note',
        round: firstNewRound,
        content: moderatorNote,
        refused: false,
      });
    }

    // Persist the extension to the DB (rounds + args + is_complete=false)
    await extendDebate(debateIdRef.current, newTotalRounds, existingArgs);

    // Update local state to match
    setActiveDebate(prev => prev ? { ...prev, rounds: newTotalRounds, isComplete: false } : prev);
    if (moderatorNote) {
      setLiveArguments(prev => [...prev, {
        debater_index: -1,
        model_id: 'moderator',
        model_name: 'Moderator note',
        round: firstNewRound,
        content: moderatorNote,
        refused: false,
        streaming: false,
      }]);
    }

    // Kick off the orchestrator without awaiting it. The new rounds will stream
    // in the background while the modal closes immediately. We bypass
    // continueDebate because it reads activeDebate from React state which
    // hasn't propagated yet.
    void runDebate({
      topic: activeDebate.topic,
      debaters: activeDebate.debaters,
      rounds: newTotalRounds,
      context: activeDebate.context || '',
      revealIdentities: true,
      initialArgs: existingArgs,
      startRound: firstNewRound,
      isNewDebate: false,
    });
  }

  // ========================================================================
  // Toggle public visibility on a completed debate (owner only)
  // ========================================================================

  async function toggleDebateVisibility(makePublic: boolean) {
    if (!activeDebate?.id) return;
    // Optimistic update
    setActiveDebate(prev => prev ? { ...prev, isPublic: makePublic } : prev);
    try {
      const res = await fetch(`/api/debates/${activeDebate.id}/visibility`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public: makePublic }),
      });
      if (!res.ok) {
        // Revert on failure
        setActiveDebate(prev => prev ? { ...prev, isPublic: !makePublic } : prev);
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to update visibility');
      }
    } catch {
      setActiveDebate(prev => prev ? { ...prev, isPublic: !makePublic } : prev);
      setError('Failed to update visibility');
    }
  }

  // ========================================================================
  // SSE event handler
  // ========================================================================

  function handleSSE(event: string, data: Record<string, unknown>) {
    switch (event) {
      case 'positions_resolved': {
        // Auto-assign just resolved any 'auto' debaters' positions. Update the
        // active debate so the header, voting options, and AI prompts in subsequent
        // rounds all see the new positions.
        const positions = data.positions as string[];
        setActiveDebate(prev => {
          if (!prev) return prev;
          const updatedDebaters = prev.debaters.map((d, i) => ({
            ...d,
            position: positions[i] ?? d.position,
            assignmentMode: 'manual' as const, // resolved — no longer auto
          }));
          return { ...prev, debaters: updatedDebaters };
        });
        break;
      }

      case 'thinking':
        setCurrentThinking(data.model_name as string);
        activeRoundRef.current = (data.round as number) || activeRoundRef.current;
        break;

      case 'token': {
        const debaterIndex = data.debater_index as number;
        const modelId = data.model_id as string;
        const token = data.token as string;
        setLiveArguments(prev => {
          const last = prev[prev.length - 1];
          if (last && last.debater_index === debaterIndex && last.streaming) {
            const updated = [...prev];
            updated[updated.length - 1] = { ...last, content: last.content + token };
            return updated;
          } else {
            setCurrentThinking(null);
            return [...prev, {
              debater_index: debaterIndex,
              model_id: modelId,
              model_name: getModelName(modelId),
              round: activeRoundRef.current,
              content: token,
              refused: false,
              streaming: true,
            }];
          }
        });
        break;
      }

      case 'argument': {
        const arg = data as unknown as DebateArgument;
        setLiveArguments(prev => {
          const updated = [...prev];
          const idx = updated.findIndex(a => a.debater_index === arg.debater_index && a.streaming);
          const final_: LiveArgument = { ...arg, streaming: false };
          if (idx >= 0) updated[idx] = final_;
          else updated.push(final_);
          return updated;
        });
        // Persistence is handled server-side now — the API route writes each
        // argument to the DB before emitting this SSE event.
        setCurrentThinking(null);
        break;
      }

      // 'round_complete' is handled implicitly — the stream closes after it
      // and the orchestrator advances. No state to update here.

      case 'model_error': {
        // Show failure inline as a failed argument card — debate continues
        const errIndex = data.debater_index as number;
        const errModelId = data.model_id as string;
        const errModelName = data.model_name as string;
        const errRound = data.round as number;
        const errMsg = data.message as string;
        setLiveArguments(prev => {
          // Remove any partial streaming entry for this debater
          const cleaned = prev.filter(a => !(a.debater_index === errIndex && a.streaming));
          return [...cleaned, {
            debater_index: errIndex,
            model_id: errModelId,
            model_name: errModelName,
            round: errRound,
            content: `[Failed to respond: ${errMsg}]`,
            refused: true,
            refusal_reason: `API error: ${errMsg}`,
            streaming: false,
          }];
        });
        setCurrentThinking(null);
        break;
      }

      case 'insufficient_tokens':
        setError('You ran out of tokens. Top up to continue debating.');
        if (isLoggedIn) {
          setShowBuyTokens(true);
        } else {
          setShowAuth(true);
        }
        break;

      case 'error':
        setError(data.message as string || 'An error occurred');
        break;
    }
  }

  // ========================================================================
  // Render helpers
  // ========================================================================

  const maxRound = liveArguments.length > 0 ? Math.max(...liveArguments.map(a => a.round)) : 0;
  const shareUrl = activeDebate?.id ? `${typeof window !== 'undefined' ? window.location.origin : ''}/arena/debate/${activeDebate.id}` : '';
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
      {/* LEFT PANEL: Form                                                 */}
      {/* ================================================================ */}
      <div className={`${styles.formPanel} ${hasDebate ? styles.formPanelHidden : ''}`}>
        <div className={styles.field}>
          <label className={styles.label}>What should they debate?</label>
          <input
            className={styles.topicInput}
            type="text"
            placeholder="e.g. Is a banana a berry?"
            maxLength={config.maxTopicLength}
            value={topic}
            onChange={e => setTopic(e.target.value)}
            disabled={generating}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Who argues what?</label>
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
                  />
                  {debaters.length > 2 && !generating && (
                    <button className={styles.removeButton} onClick={() => removeDebater(i)}>
                      <X size={14} />
                    </button>
                  )}
                </div>
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
                  {findModel(debater.modelId)?.family !== 'user' && (
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
              </div>
            ))}
            {canAddModel && !generating && (
              isLoggedIn ? (
                <button className={styles.addModel} onClick={addDebater}>+ Add model</button>
              ) : (
                <button className={styles.lockedOption} onClick={() => setShowAuth(true)}>
                  + Add model <span className={styles.lockedBadge}>Sign up</span>
                </button>
              )
            )}
          </div>

          <div className={styles.toggleGroup}>
            <div className={styles.toggleRow}>
              <span className={styles.toggleText}>Anonymous opponents</span>
              <button
                type="button"
                className={`${styles.switch} ${!revealIdentities ? styles.switchOn : ''}`}
                onClick={() => !generating && setRevealIdentities(!revealIdentities)}
                disabled={generating}
                aria-label="Toggle anonymous opponents"
              >
                <span className={styles.switchKnob} />
              </button>
            </div>
            <span className={styles.toggleDescription}>
              {revealIdentities
                ? 'Models know who they\'re debating.'
                : 'Models don\'t know their opponents — even if it\'s themselves.'}
            </span>
          </div>
        </div>

        {hasUserDebater ? (
          <div className={styles.field}>
            <label className={styles.label}>Rounds</label>
            <p className={styles.humanRoundsNote}>
              Up to {HUMAN_DEBATE_MAX_ROUNDS} rounds — end the debate any time on your turn.
            </p>
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label}>Rounds</label>
            <div className={styles.roundSelector}>
              {[3, 5, 7].map(n => {
                const locked = !isLoggedIn && n > 3;
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

        <div className={styles.submitRow}>
          {tokenBalance !== null && (
            <span className={styles.tokenBalance}>
              <span className={styles.tokenCount}>{tokenBalance}</span> tokens
              {!canAffordAny && (
                <button
                  className={styles.buyLink}
                  onClick={() => isLoggedIn ? setShowBuyTokens(true) : setShowAuth(true)}
                >
                  {isLoggedIn ? 'Top up' : 'Sign up for 20 free'}
                </button>
              )}
            </span>
          )}
          <button
            className={styles.submitButton}
            disabled={!isValid || generating || !canAffordAny}
            onClick={generateDebate}
          >
            {generating ? 'Debating...' : `Start Debate (${totalDebateCost} ${totalDebateCost === 1 ? 'token' : 'tokens'})`}
          </button>
        </div>
        {isValid && canAffordAny && !canAffordFull && (
          <p className={styles.tokenWarning}>
            This debate costs {totalDebateCost} tokens but you have {tokenBalance}. It will stop when your tokens run out.
          </p>
        )}

        {error && <p className={styles.error}>{error}</p>}

        {/* Debate history */}
        {isLoggedIn && (historyLoading || history.length > 0) && (
          <div className={styles.historySection}>
            <div className={styles.historyHeader}>
              <span className={styles.label}>Your Debates</span>
            </div>
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
                                  setActiveDebate(null);
                                  setLiveArguments([]);
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
      {/* RIGHT PANEL: Debate thread                                       */}
      {/* ================================================================ */}
      <div className={styles.debatePanel} ref={debatePanelRef}>
        {/* Mobile: back to form */}
        {hasDebate && !generating && (
          <button
            className={styles.mobileBackButton}
            onClick={() => { setActiveDebate(null); setLiveArguments([]); }}
          >
            <ChevronLeft size={16} /> New debate
          </button>
        )}

        {!hasDebate ? (
          <div className={styles.debateEmpty}>
            <img src="/brand/icon.png" alt="" className={styles.emptyIcon} />
            <p className={styles.emptyText}>
              Configure your debate and press Start.
              Models will argue their positions in real time.
            </p>
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

            {/* User-turn input — appears when a 'user' debater needs to type their argument */}
            {pendingUserTurn && (
              <UserTurnInput
                displayName={pendingUserTurn.displayName}
                position={pendingUserTurn.position}
                colour={getModelColour('user')}
                isLastInRound={pendingUserTurn.isLastInRound}
                onSubmit={handleUserSubmit}
              />
            )}

            {/* Continue incomplete debate.
                Hidden when the orchestrator is generating OR when a user input
                is already pending (UserTurnInput is the continuation in that case). */}
            {activeDebate && !activeDebate.isComplete && !generating && !pendingUserTurn && liveArguments.length > 0 && (
              <div className={styles.continueDebate}>
                <p className={styles.continueText}>
                  {nextDebater?.isUser
                    ? "It's your turn to argue."
                    : `This debate was interrupted — ${liveArguments.length} arguments completed.`}
                </p>
                <button className={styles.submitButton} onClick={continueDebate}>
                  {nextDebater?.isUser ? 'Take Your Turn' : 'Continue Debate'}
                </button>
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

                {!isLoggedIn && (
                  <div className={styles.signupPrompt}>
                    <span className={styles.signupPromptTitle}>
                      Sign up to save debates and get 20 free tokens
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

                {activeDebate.id && (
                  <button className={styles.shareButton} onClick={() => setShowShareModal(true)}>
                    Share This Debate
                  </button>
                )}

                {isLoggedIn && activeDebate.id && !liveArguments.every(a => a.refused) && (
                  <div className={styles.publicToggleRow}>
                    <div className={styles.publicToggleText}>
                      <span className={styles.publicToggleLabel}>List in public feed</span>
                      <span className={styles.publicToggleDescription}>
                        {activeDebate.isPublic
                          ? 'Visible on /explore. Anyone can find this debate.'
                          : 'Only people with the link can find this debate.'}
                      </span>
                    </div>
                    <button
                      type="button"
                      className={`${styles.switch} ${activeDebate.isPublic ? styles.switchOn : ''}`}
                      onClick={() => toggleDebateVisibility(!activeDebate.isPublic)}
                      aria-label="Toggle public listing"
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
                  {activeDebate.rounds < 15 && !liveArguments.every(a => a.refused) && (
                    <button
                      className={styles.secondaryButton}
                      onClick={() => setShowExtendModal(true)}
                    >Extend Debate</button>
                  )}
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
