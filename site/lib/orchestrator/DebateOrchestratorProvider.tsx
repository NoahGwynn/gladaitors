// ============================================================================
// Debate Orchestrator Provider — global, layout-mounted state for the
// round-by-round debate execution loop.
// ============================================================================
//
// WHY THIS EXISTS:
//   The orchestrator (the loop that POSTs each round, reads SSE tokens,
//   handles user-turn pauses, and persists state) used to live inside the
//   /arena/debate page component. When the user navigated away from that
//   page — to /explore, the history sidebar, etc. — the page unmounted,
//   React tore down the state, and the in-flight fetch aborted. The debate
//   died mid-stream.
//
//   Lifting the orchestrator into a context provider mounted in the root
//   layout means the provider survives all in-app navigation. The page
//   becomes a thin consumer that reads from the provider and renders.
//
// THREE HOOKS FOR RE-RENDER SCOPE:
//   useDebateStatus()  — slow-changing fields. Subscribed by sidebar / nav.
//   useDebateStream()  — fast-changing fields (per-token). Subscribed only by
//                        the arena page's argument list.
//   useDebateActions() — stable function references. Always safe to call.
//
//   Splitting the surface like this means a sidebar badge that only cares
//   about "is a debate running" doesn't re-render 30 times per second
//   while tokens stream.
//
// SOURCE OF TRUTH:
//   - DB row is the canonical persistent state (server writes per-argument).
//   - Provider state is the in-memory mirror for the current tab.
//   - The page is a pure consumer.
//
// FUTURE COMMITS in this refactor will add:
//   - Lease claim / heartbeat / release (commit 4)
//   - Supabase Realtime subscription + follower mode (commit 5)
//   - Take-over UX (commit 6)
//
// See REALTIME_ORCHESTRATOR_REFACTOR.md at the repo root for the full plan.
// ============================================================================

'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  createDebateRecord,
  completeDebate as dbCompleteDebate,
  extendDebate as dbExtendDebate,
  deleteDebate,
  getSessionId,
} from '@/lib/debates';
import { fetchTokenBalance, notifyBalanceChanged } from '@/lib/tokens';
import { getModelName } from '@/lib/models';
import type { Debate, DebateArgument } from '@/lib/types';

// ----------------------------------------------------------------------------
// Public types (re-exported for consumer convenience)
// ----------------------------------------------------------------------------

export interface DebaterConfig {
  modelId: string;
  position: string;
  /** 'manual' = user typed the position; 'auto' = AI picks its own stance on round 1 */
  assignmentMode?: 'manual' | 'auto';
}

export interface ActiveDebate {
  id: string | null;
  topic: string;
  debaters: DebaterConfig[];
  rounds: number;
  context?: string;
  isComplete: boolean;
  isPublic?: boolean;
}

export interface LiveArgument extends DebateArgument {
  streaming: boolean;
}

export interface PendingUserTurn {
  debaterIndex: number;
  displayName: string;
  position: string;
  round: number;
  isLastInRound: boolean;
}

export interface StartDebateConfig {
  topic: string;
  debaters: DebaterConfig[];
  rounds: number;
  context: string;
  revealIdentities: boolean;
}

export type ErrorReason = 'insufficient_tokens' | 'safety' | 'auth' | 'other';

export type SubmitResult = { ok: true } | { ok: false; error: string };

// ----------------------------------------------------------------------------
// Internal types
// ----------------------------------------------------------------------------

interface RunDebateConfig extends StartDebateConfig {
  initialArgs: DebateArgument[];
  startRound: number;
  /** Set true on the very first call of a brand-new debate so we delete the empty record on safety/auth failure. */
  isNewDebate: boolean;
}

interface RoundResult {
  newArgs: DebateArgument[];
  insufficientTokens: boolean;
  error: string | null;
  userTurnNeeded: {
    debaterIndex: number;
    displayName: string;
    position: string;
    round: number;
  } | null;
}

type UserTurnResult =
  | { kind: 'submitted'; arg: DebateArgument }
  | { kind: 'ended'; arg: DebateArgument };

// ----------------------------------------------------------------------------
// Context shapes
// ----------------------------------------------------------------------------

interface StatusContextValue {
  activeDebate: ActiveDebate | null;
  generating: boolean;
  error: string | null;
  /** What kind of error fired (if any). Used by the page to decide whether to show the buy-tokens modal, etc. */
  errorReason: ErrorReason | null;
  /** Set briefly when a debate has just transitioned to complete. The page acknowledges this to refresh history. */
  justCompleted: boolean;
}

interface StreamContextValue {
  liveArguments: LiveArgument[];
  currentThinking: string | null;
  pendingUserTurn: PendingUserTurn | null;
}

interface ActionsContextValue {
  /** Start a brand-new debate. Creates the DB record, then runs the round loop. */
  startDebate(config: StartDebateConfig): Promise<SubmitResult>;
  /** Resume an incomplete debate already loaded into state. */
  continueDebate(): Promise<void>;
  /** Add rounds (and an optional moderator note) to a completed debate, then run them. */
  extendActiveDebate(extraRounds: number, moderatorNote: string): Promise<void>;
  /** Replace the active debate with one loaded from history (read-only display). */
  loadDebate(debate: Debate): void;
  /** Clear the active debate, return to the empty form. */
  resetDebate(): void;

  /** Submit the user's argument for a pending human turn. Returns ok or an error message. */
  submitUserTurn(text: string, intent: 'continue' | 'end'): Promise<SubmitResult>;
  /** Cancel the pending human turn. The orchestrator stops cleanly; the debate stays incomplete. */
  cancelUserTurn(): void;

  /** Patch fields on the active debate (e.g., toggle isPublic). */
  updateActiveDebate(patch: Partial<ActiveDebate>): void;

  /** Page calls this after handling justCompleted (refreshing history, etc.). */
  acknowledgeJustCompleted(): void;
  /** Page calls this after handling an error (showing modal, etc.) so the next error is detectable. */
  clearError(): void;
}

const StatusContext = createContext<StatusContextValue | null>(null);
const StreamContext = createContext<StreamContextValue | null>(null);
const ActionsContext = createContext<ActionsContextValue | null>(null);

// ----------------------------------------------------------------------------
// Hooks
// ----------------------------------------------------------------------------

export function useDebateStatus(): StatusContextValue {
  const v = useContext(StatusContext);
  if (!v) throw new Error('useDebateStatus must be used inside DebateOrchestratorProvider');
  return v;
}

export function useDebateStream(): StreamContextValue {
  const v = useContext(StreamContext);
  if (!v) throw new Error('useDebateStream must be used inside DebateOrchestratorProvider');
  return v;
}

export function useDebateActions(): ActionsContextValue {
  const v = useContext(ActionsContext);
  if (!v) throw new Error('useDebateActions must be used inside DebateOrchestratorProvider');
  return v;
}

// ----------------------------------------------------------------------------
// Provider
// ----------------------------------------------------------------------------

export function DebateOrchestratorProvider({ children }: { children: ReactNode }) {
  // --- State ---
  const [activeDebate, setActiveDebate] = useState<ActiveDebate | null>(null);
  const [liveArguments, setLiveArguments] = useState<LiveArgument[]>([]);
  const [generating, setGenerating] = useState(false);
  const [currentThinking, setCurrentThinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<ErrorReason | null>(null);
  const [pendingUserTurn, setPendingUserTurn] = useState<PendingUserTurn | null>(null);
  const [justCompleted, setJustCompleted] = useState(false);

  // --- Refs (closure-stable across re-renders) ---
  const debateIdRef = useRef<string | null>(null);
  const activeRoundRef = useRef(1);
  const userTurnResolverRef = useRef<((result: UserTurnResult | null) => void) | null>(null);

  // ========================================================================
  // SSE event handler
  // ========================================================================

  const handleSSE = useCallback((event: string, data: Record<string, unknown>) => {
    switch (event) {
      case 'positions_resolved': {
        const positions = data.positions as string[];
        setActiveDebate(prev => {
          if (!prev) return prev;
          const updatedDebaters = prev.debaters.map((d, i) => ({
            ...d,
            position: positions[i] ?? d.position,
            assignmentMode: 'manual' as const,
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
        const errIndex = data.debater_index as number;
        const errModelId = data.model_id as string;
        const errModelName = data.model_name as string;
        const errRound = data.round as number;
        const errMsg = data.message as string;
        setLiveArguments(prev => {
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
        setErrorReason('insufficient_tokens');
        break;

      case 'error':
        setError((data.message as string) || 'An error occurred');
        setErrorReason('other');
        break;
    }
  }, []);

  // ========================================================================
  // Single round (one POST to /api/debate)
  // ========================================================================

  const runOneRound = useCallback(async (
    config: RunDebateConfig,
    existingArguments: DebateArgument[],
    currentRound: number,
  ): Promise<RoundResult> => {
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
  }, [handleSSE]);

  // ========================================================================
  // User-turn prompt — pause the orchestrator until the user submits
  // ========================================================================

  const promptUserTurn = useCallback((
    turn: NonNullable<RoundResult['userTurnNeeded']>,
    isLastInRound: boolean,
  ): Promise<UserTurnResult | null> => {
    return new Promise(resolve => {
      setPendingUserTurn({ ...turn, isLastInRound });
      userTurnResolverRef.current = resolve;
    });
  }, []);

  // ========================================================================
  // Run the full multi-round loop
  // ========================================================================

  const runDebate = useCallback(async (config: RunDebateConfig) => {
    setGenerating(true);
    setError(null);
    setErrorReason(null);
    setCurrentThinking(null);

    const allArgs: DebateArgument[] = [...config.initialArgs];
    let currentRound = config.startRound;
    let endRequested = false;

    try {
      outer: while (currentRound <= config.rounds) {
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
              setErrorReason('insufficient_tokens');
            } else {
              setErrorReason('other');
            }
            setError(result.error);
            return;
          }

          if (result.insufficientTokens) {
            // SSE handler already set the error / errorReason. Stop the loop.
            return;
          }

          allArgs.push(...result.newArgs);

          if (result.userTurnNeeded) {
            const isLastInRound = result.userTurnNeeded.debaterIndex === config.debaters.length - 1;
            const userResult = await promptUserTurn(result.userTurnNeeded, isLastInRound);
            if (!userResult) {
              // Cancelled by the user — stop cleanly. Debate stays incomplete.
              return;
            }
            allArgs.push(userResult.arg);
            // The user's argument is sent to the server in the next round POST
            // as part of `existingArguments`; the server merges and persists
            // it before generating the next AI argument.
            if (userResult.kind === 'ended') {
              endRequested = true;
              if (isLastInRound) {
                roundDone = true;
              }
              // else: continue inner loop, API will fill in the rest of the round
            }
          } else {
            roundDone = true;
          }
        }

        if (endRequested) break outer;

        currentRound++;
        // Surface the live token balance update via the global event bus.
        notifyBalanceChanged();
        void fetchTokenBalance();
      }

      // Either all rounds completed naturally, or the user explicitly ended the
      // debate after the current round finished. Server marks is_complete=true
      // on the natural-end path; on the early-end path the page will fall back
      // to dbCompleteDebate via the justCompleted observer.
      setJustCompleted(true);
      setActiveDebate(prev => prev ? { ...prev, isComplete: true } : prev);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setErrorReason('other');
    } finally {
      setGenerating(false);
      setCurrentThinking(null);
      setPendingUserTurn(null);
      userTurnResolverRef.current = null;
      notifyBalanceChanged();
    }
  }, [runOneRound, promptUserTurn]);

  // ========================================================================
  // Public actions
  // ========================================================================

  const startDebate = useCallback(async (config: StartDebateConfig): Promise<SubmitResult> => {
    if (generating) {
      return { ok: false, error: 'A debate is already running. Please wait or end it first.' };
    }

    setActiveDebate({
      id: null,
      topic: config.topic,
      debaters: config.debaters,
      rounds: config.rounds,
      context: config.context,
      isComplete: false,
    });
    setLiveArguments([]);
    setError(null);
    setErrorReason(null);
    setPendingUserTurn(null);
    userTurnResolverRef.current = null;
    debateIdRef.current = null;
    activeRoundRef.current = 1;

    // Create the database record up-front (positions keyed by index)
    const positions: Record<string, string> = {};
    config.debaters.forEach((d, i) => { positions[String(i)] = d.position; });
    const newId = await createDebateRecord({
      topic: config.topic,
      positions,
      models: config.debaters.map(d => d.modelId),
      rounds: config.rounds,
      context: config.context || undefined,
    });
    if (newId) {
      debateIdRef.current = newId;
      setActiveDebate(prev => prev ? { ...prev, id: newId } : prev);
    }

    await runDebate({
      ...config,
      initialArgs: [],
      startRound: 1,
      isNewDebate: true,
    });

    return { ok: true };
  }, [generating, runDebate]);

  const continueDebate = useCallback(async () => {
    if (!activeDebate || generating || activeDebate.isComplete) return;

    // Build prior args from current state (drop streaming placeholders)
    const existingArgs: DebateArgument[] = liveArguments.filter(a => !a.streaming).map(a => ({
      debater_index: a.debater_index,
      model_id: a.model_id,
      model_name: a.model_name,
      round: a.round,
      content: a.content,
      refused: a.refused,
      refusal_reason: a.refusal_reason,
    }));

    // Find the first round where not all debaters have argued (ignoring moderator notes)
    let resumeRound = activeDebate.rounds + 1;
    for (let r = 1; r <= activeDebate.rounds; r++) {
      const argsInRound = existingArgs.filter(a => a.round === r && a.model_id !== 'moderator').length;
      if (argsInRound < activeDebate.debaters.length) {
        resumeRound = r;
        break;
      }
    }
    if (resumeRound > activeDebate.rounds) return;

    await runDebate({
      topic: activeDebate.topic,
      debaters: activeDebate.debaters,
      rounds: activeDebate.rounds,
      context: activeDebate.context || '',
      revealIdentities: true,
      initialArgs: existingArgs,
      startRound: resumeRound,
      isNewDebate: false,
    });
  }, [activeDebate, generating, liveArguments, runDebate]);

  const extendActiveDebate = useCallback(async (extraRounds: number, moderatorNote: string) => {
    if (!activeDebate || !debateIdRef.current) return;

    const newTotalRounds = activeDebate.rounds + extraRounds;
    const firstNewRound = activeDebate.rounds + 1;

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

    await dbExtendDebate(debateIdRef.current, newTotalRounds, existingArgs);

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
  }, [activeDebate, liveArguments, runDebate]);

  const loadDebate = useCallback((debate: Debate) => {
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
    setErrorReason(null);
    setPendingUserTurn(null);
    userTurnResolverRef.current = null;
  }, []);

  const resetDebate = useCallback(() => {
    setActiveDebate(null);
    setLiveArguments([]);
    setGenerating(false);
    setCurrentThinking(null);
    setError(null);
    setErrorReason(null);
    setPendingUserTurn(null);
    userTurnResolverRef.current = null;
    debateIdRef.current = null;
    activeRoundRef.current = 1;
  }, []);

  const submitUserTurn = useCallback(async (
    text: string,
    intent: 'continue' | 'end',
  ): Promise<SubmitResult> => {
    if (!pendingUserTurn) return { ok: false, error: 'No pending turn' };

    // Safety check
    const res = await fetch('/api/debate/check-argument', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return { ok: false, error: 'Safety check failed. Please try again.' };
    const { safe } = await res.json();
    if (!safe) {
      return { ok: false, error: 'This argument violates our usage policy. Please rewrite and try again.' };
    }

    const arg: DebateArgument = {
      debater_index: pendingUserTurn.debaterIndex,
      model_id: 'user',
      model_name: pendingUserTurn.displayName,
      round: pendingUserTurn.round,
      content: text,
      refused: false,
    };

    setLiveArguments(prev => [...prev, { ...arg, streaming: false }]);

    setPendingUserTurn(null);
    const resolver = userTurnResolverRef.current;
    userTurnResolverRef.current = null;
    if (resolver) {
      resolver(intent === 'end' ? { kind: 'ended', arg } : { kind: 'submitted', arg });
    }

    return { ok: true };
  }, [pendingUserTurn]);

  const cancelUserTurn = useCallback(() => {
    setPendingUserTurn(null);
    const resolver = userTurnResolverRef.current;
    userTurnResolverRef.current = null;
    if (resolver) resolver(null);
  }, []);

  const updateActiveDebate = useCallback((patch: Partial<ActiveDebate>) => {
    setActiveDebate(prev => prev ? { ...prev, ...patch } : prev);
  }, []);

  const acknowledgeJustCompleted = useCallback(() => {
    setJustCompleted(false);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
    setErrorReason(null);
  }, []);

  // ========================================================================
  // Early-end fallback: when the orchestrator finishes the natural-end path
  // the server has already set is_complete=true. But the early-end path
  // (user clicked "End debate" before the final round) only sets local state
  // — fall back to the legacy completeDebate write here so the DB stays in
  // sync. Idempotent against the natural-end case.
  // ========================================================================

  useEffect(() => {
    if (!justCompleted) return;
    if (!debateIdRef.current) return;
    void dbCompleteDebate(debateIdRef.current);
  }, [justCompleted]);

  // ========================================================================
  // Context value assembly
  // ========================================================================

  const statusValue: StatusContextValue = {
    activeDebate,
    generating,
    error,
    errorReason,
    justCompleted,
  };

  const streamValue: StreamContextValue = {
    liveArguments,
    currentThinking,
    pendingUserTurn,
  };

  const actionsValue: ActionsContextValue = {
    startDebate,
    continueDebate,
    extendActiveDebate,
    loadDebate,
    resetDebate,
    submitUserTurn,
    cancelUserTurn,
    updateActiveDebate,
    acknowledgeJustCompleted,
    clearError,
  };

  return (
    <StatusContext.Provider value={statusValue}>
      <StreamContext.Provider value={streamValue}>
        <ActionsContext.Provider value={actionsValue}>
          {children}
        </ActionsContext.Provider>
      </StreamContext.Provider>
    </StatusContext.Provider>
  );
}
