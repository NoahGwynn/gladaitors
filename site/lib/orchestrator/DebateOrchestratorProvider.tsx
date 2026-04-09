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
  useMemo,
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
import { createClient } from '@/lib/supabase';
import type { Debate, DebateArgument } from '@/lib/types';

// ----------------------------------------------------------------------------
// Lease constants
// ----------------------------------------------------------------------------

/** How often the driving tab refreshes its heartbeat. */
const HEARTBEAT_INTERVAL_MS = 5_000;

/** When claiming the lease as a takeover, force-take if no heartbeat has
 *  landed in this many seconds. The same threshold the dashboard uses to
 *  decide whether to show the "other tab isn't responding" message. */
const STALE_LEASE_THRESHOLD_SECS = 15;

/** Per-tab identity for the driver lease.
 *
 *  IMPORTANT: this is a SEPARATE id from getSessionId() (which uses
 *  localStorage and is therefore shared between every tab in the same
 *  browser). The lease must be per-tab — otherwise two tabs in the same
 *  browser both look like "already_owner" to the claim RPC and both can
 *  drive the same debate at once.
 *
 *  sessionStorage is per-tab in browsers and survives reloads of that tab,
 *  which is what we want: refreshing the page keeps the same lease key so
 *  the orchestrator can reclaim immediately after a reload.
 */
function getTabId(): string {
  if (typeof window === 'undefined') return '';
  const KEY = 'gladaitors_tab_id';
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

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
  /** True when this tab currently holds the driver lease for the active debate. */
  isDriver: boolean;
  /** Orchestrator status from the DB. Followers (non-driver tabs) read this
   *  to render their "what is the driver doing" indicator. */
  dbStatus: 'idle' | 'running' | 'awaiting_human' | 'complete' | 'error' | null;
  /** Current round number from the DB. Used for progress display in follower mode. */
  dbCurrentRound: number;
  /** True if the driver tab is paused on a human turn (its own user, not us). */
  dbAwaitingHuman: boolean;
  /** True when this tab should render in read-only follower mode: the row
   *  is being driven by another live tab (driver_session_id is set, isn't us,
   *  and status is running or awaiting_human). */
  isFollowing: boolean;
  /** True when the recorded driver lease has gone stale — no heartbeat in
   *  more than STALE_LEASE_THRESHOLD_SECS. Drives the "other tab isn't
   *  responding" take-over button label. */
  dbDriverStale: boolean;
  /** Derived: should the take-over button be visible right now?
   *  Per Q1 of REALTIME_ORCHESTRATOR_REFACTOR.md, true when:
   *    - We're not the driver, AND there's a debate loaded, AND
   *    - dbStatus is 'awaiting_human' (always allowed), OR
   *    - the driver lease is stale (dead tab fallback). */
  canTakeOver: boolean;
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
  /** Force-claim the lease from another tab and resume from the persisted
   *  state. Used by the take-over button in follower mode. Only valid when
   *  canTakeOver is true. */
  takeOverDebate(): Promise<SubmitResult>;

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
  const [isDriver, setIsDriver] = useState(false);
  const [dbStatus, setDbStatus] = useState<StatusContextValue['dbStatus']>(null);
  const [dbCurrentRound, setDbCurrentRound] = useState(0);
  const [dbAwaitingHuman, setDbAwaitingHuman] = useState(false);
  const [dbDriverSessionId, setDbDriverSessionId] = useState<string | null>(null);
  const [dbDriverHeartbeatAt, setDbDriverHeartbeatAt] = useState<string | null>(null);
  /** Trick to force re-evaluation of the stale-heartbeat derived flag every
   *  few seconds without spamming React state. We bump this on a setInterval
   *  whenever a driver lease is set; the dbDriverStale useMemo depends on it. */
  const [staleTick, setStaleTick] = useState(0);

  // --- Refs (closure-stable across re-renders) ---
  const debateIdRef = useRef<string | null>(null);
  const activeRoundRef = useRef(1);
  const userTurnResolverRef = useRef<((result: UserTurnResult | null) => void) | null>(null);
  /** Per-tab id used as the driver lease key. NOT the same as the per-browser
   *  session id from getSessionId() — see the comment on getTabId(). */
  const tabIdRef = useRef<string>('');
  /** Heartbeat timer handle while we hold the lease. */
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Lazy-init the tab id once on first render. sessionStorage only works in
  // the browser, so doing this in useEffect (instead of useState's lazy init)
  // keeps SSR happy.
  useEffect(() => {
    if (!tabIdRef.current) tabIdRef.current = getTabId();
  }, []);

  // ========================================================================
  // Lease management — see REALTIME_ORCHESTRATOR_REFACTOR.md for the design
  // ========================================================================

  /** Claim the driver lease for the current debateIdRef. Returns the RPC verdict. */
  const claimLease = useCallback(async (
    forceIfStaleSecs: number = STALE_LEASE_THRESHOLD_SECS,
  ): Promise<{ claimed: boolean; reason: string }> => {
    const debateId = debateIdRef.current;
    if (!debateId) return { claimed: false, reason: 'no_debate_id' };
    if (!tabIdRef.current) tabIdRef.current = getTabId();

    const supabase = createClient();
    const { data, error } = await supabase.rpc('claim_debate_lease', {
      p_debate_id: debateId,
      p_session_id: tabIdRef.current,
      p_force_if_stale_secs: forceIfStaleSecs,
    });

    if (error) {
      console.error('[LEASE CLAIM] RPC error:', error);
      return { claimed: false, reason: 'rpc_error' };
    }

    const verdict = (data ?? {}) as { claimed?: boolean; reason?: string };
    return { claimed: !!verdict.claimed, reason: verdict.reason ?? 'unknown' };
  }, []);

  /** Refresh the heartbeat. Returns the current driver session id from the DB
   *  (which we compare against ours to detect being kicked off). */
  const heartbeatLease = useCallback(async (): Promise<string | null> => {
    const debateId = debateIdRef.current;
    if (!debateId || !tabIdRef.current) return null;

    const supabase = createClient();
    const { data, error } = await supabase.rpc('heartbeat_debate_lease', {
      p_debate_id: debateId,
      p_session_id: tabIdRef.current,
    });
    if (error) {
      console.error('[LEASE HEARTBEAT] RPC error:', error);
      return null;
    }
    return (data as string | null) ?? null;
  }, []);

  /** Release the lease if we still hold it. Idempotent. */
  const releaseLease = useCallback(async (): Promise<void> => {
    const debateId = debateIdRef.current;
    if (!debateId || !tabIdRef.current) return;
    const supabase = createClient();
    await supabase.rpc('release_debate_lease', {
      p_debate_id: debateId,
      p_session_id: tabIdRef.current,
    });
  }, []);

  /** Start the heartbeat interval. Idempotent — clears any existing one first. */
  const startHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = setInterval(async () => {
      const currentDriver = await heartbeatLease();
      // If the DB says we're no longer the driver, another tab took over.
      // Stop heartbeating and flip isDriver. The orchestrator's in-flight
      // fetch will keep streaming until it naturally hits the next yield —
      // commit 5 will add a tear-down via Realtime subscription that aborts
      // it cleanly. For commit 4 this just stops the timer.
      if (currentDriver !== tabIdRef.current) {
        if (heartbeatTimerRef.current) {
          clearInterval(heartbeatTimerRef.current);
          heartbeatTimerRef.current = null;
        }
        setIsDriver(false);
      }
    }, HEARTBEAT_INTERVAL_MS);
  }, [heartbeatLease]);

  /** Stop the heartbeat interval. */
  const stopHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }, []);

  // Cleanup heartbeat on unmount (typically only fires on full app teardown
  // since the provider lives in the root layout — page navigations don't
  // unmount it).
  useEffect(() => {
    return () => {
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    };
  }, []);

  // Release the driver lease on tab unload (close, refresh, navigate to
  // another origin). Uses fetch with keepalive: true so the request
  // survives the page unload event. Without this, the lease would only
  // clear after the 15s stale-heartbeat threshold, leaving other tabs
  // (or the same tab after refresh) stuck in follower mode.
  useEffect(() => {
    const handler = () => {
      if (!isDriver) return;
      const debateId = debateIdRef.current;
      const tabId = tabIdRef.current;
      if (!debateId || !tabId) return;
      try {
        // keepalive lets the POST survive the unload — fire-and-forget.
        fetch('/api/debate/release-lease', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ debateId, tabId }),
          keepalive: true,
        });
      } catch {
        // Best-effort. Heartbeat staleness is the backup.
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDriver]);

  // ========================================================================
  // Realtime subscription — keep follower tabs in sync with the driver
  // ========================================================================
  //
  // Subscribes to UPDATE events on the active debate's row and reconciles
  // the incoming row state with our local state per the strict-merge rules
  // (see Q3 in REALTIME_ORCHESTRATOR_REFACTOR.md):
  //
  //   - DB always wins for status fields (status, current_round, is_complete,
  //     awaiting_debater_index, driver_session_id).
  //   - For arguments, LOCAL is authoritative. Any (round, debater_index)
  //     already in local state stays as-is. Incoming args at keys we don't
  //     have are added. The currently-streaming arg (if any) is never
  //     clobbered by an incoming complete arg.
  //
  // The subscription is keyed on activeDebate.id and re-subscribes whenever
  // the active debate changes.

  useEffect(() => {
    const debateId = activeDebate?.id;
    if (!debateId) return;

    const supabase = createClient();
    const channel = supabase
      .channel(`debate-${debateId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'debates',
          filter: `id=eq.${debateId}`,
        },
        (payload) => {
          const row = payload.new as Debate;
          reconcileRealtimeUpdate(row);
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // We deliberately depend only on the debate id — we don't want to
    // resubscribe on every state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDebate?.id]);

  /** Strict-merge incoming row arguments into local liveArguments. */
  const mergeRealtimeArgs = useCallback((
    local: LiveArgument[],
    incoming: DebateArgument[] | undefined,
  ): LiveArgument[] => {
    if (!incoming || incoming.length === 0) return local;

    // Streaming arg in local always wins — never overwritten by Realtime echo
    const streamingArg = local.find(a => a.streaming);
    const localKeys = new Set(
      local.filter(a => !a.streaming).map(a => `${a.round}-${a.debater_index}`),
    );

    const result = [...local];
    let added = false;
    for (const arg of incoming) {
      const key = `${arg.round}-${arg.debater_index}`;
      // Already have a complete local copy
      if (localKeys.has(key)) continue;
      // Don't clobber the in-flight streaming arg
      if (
        streamingArg &&
        streamingArg.round === arg.round &&
        streamingArg.debater_index === arg.debater_index
      ) continue;
      result.push({ ...arg, streaming: false });
      added = true;
    }
    // Avoid creating a new array reference if nothing actually changed —
    // prevents unnecessary re-renders.
    if (!added) return local;
    // Sort by (round, debater_index) so the rendered thread stays in order
    // even when args arrive out of sequence over the wire.
    result.sort((a, b) => {
      if (a.round !== b.round) return a.round - b.round;
      return a.debater_index - b.debater_index;
    });
    return result;
  }, []);

  /** Apply a Realtime row update to local state.
   *
   *  IMPORTANT: this callback must NOT close over React state values like
   *  `isDriver`, because the Realtime subscription effect captures the
   *  current `reconcileRealtimeUpdate` reference at subscription time and
   *  doesn't re-subscribe when state changes. Reading isDriver from a
   *  closure here would mean the callback always sees the value from the
   *  moment the subscription was created — usually `false`, before runDebate
   *  ever set it to `true`.
   *
   *  Instead, detect "we were driving" via REFS (heartbeatTimerRef and
   *  userTurnResolverRef), which are always current. The state setters
   *  (setIsDriver, setPendingUserTurn) don't suffer this problem because
   *  React provides stable setter references.
   */
  const reconcileRealtimeUpdate = useCallback((row: Debate) => {
    const newDriver = row.driver_session_id ?? null;

    // If the row says someone else owns the lease and we have a heartbeat
    // running (= we thought we were the driver), tear it down.
    if (newDriver !== tabIdRef.current && heartbeatTimerRef.current) {
      stopHeartbeat();
      setIsDriver(false);
    }

    // If the row says someone else owns the lease and we have a pending
    // user-turn resolver, we just got kicked off mid-pause. Cancel the
    // pending turn so the orchestrator's runDebate loop unwinds cleanly
    // — otherwise the input box would stay visible in this tab forever.
    if (
      newDriver &&
      newDriver !== tabIdRef.current &&
      userTurnResolverRef.current
    ) {
      const resolver = userTurnResolverRef.current;
      userTurnResolverRef.current = null;
      setPendingUserTurn(null);
      resolver(null);
    }

    // Status fields — DB always wins
    if (row.status !== undefined) setDbStatus(row.status);
    if (row.current_round !== undefined) setDbCurrentRound(row.current_round);
    setDbAwaitingHuman(row.status === 'awaiting_human');
    setDbDriverSessionId(row.driver_session_id ?? null);
    setDbDriverHeartbeatAt(row.driver_heartbeat_at ?? null);

    // 3. is_complete — followers learn the debate is done from here
    if (row.is_complete) {
      setActiveDebate(prev => prev && !prev.isComplete ? { ...prev, isComplete: true } : prev);
    }

    // 4. Positions (driver may have just resolved auto-assign)
    if (row.positions) {
      const positions = row.positions as Record<string, string>;
      setActiveDebate(prev => {
        if (!prev) return prev;
        const updatedDebaters = prev.debaters.map((d, i) => ({
          ...d,
          position: positions[String(i)] ?? d.position,
        }));
        return { ...prev, debaters: updatedDebaters };
      });
    }

    // 5. Arguments — strict merge
    setLiveArguments(prev => mergeRealtimeArgs(prev, row.arguments));
  }, [stopHeartbeat, mergeRealtimeArgs]);

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
    // Claim the lease before doing anything else. If another tab is currently
    // driving this debate (fresh heartbeat), refuse to start — single-driver
    // is enforced at the orchestrator level. The page surfaces the error.
    const claim = await claimLease();
    if (!claim.claimed) {
      const message = claim.reason === 'active_driver'
        ? 'This debate is already running in another tab. Switch to that tab to see it.'
        : claim.reason === 'rpc_error'
          ? 'Could not start the debate (database error).'
          : 'Could not claim this debate.';
      setError(message);
      setErrorReason('other');
      return;
    }
    setIsDriver(true);
    startHeartbeat();

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
      // The lease is held for the entire runDebate lifecycle, including
      // human-turn pauses (promptUserTurn awaits inside the loop, so the
      // finally block doesn't run until the user submits or cancels).
      // Always release here so other tabs can claim immediately.
      stopHeartbeat();
      await releaseLease();
      setIsDriver(false);
      notifyBalanceChanged();
    }
  }, [runOneRound, promptUserTurn, claimLease, startHeartbeat, stopHeartbeat, releaseLease]);

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
      // Per-debater "AI picked its own stance" flags + the anonymous-mode
      // flag, recorded once at creation so the shared debate view can
      // surface them later.
      autoAssigned: config.debaters.map(d => d.assignmentMode === 'auto'),
      revealIdentities: config.revealIdentities,
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
    // If we held a lease on a different debate, release it first.
    if (debateIdRef.current && debateIdRef.current !== debate.id && isDriver) {
      stopHeartbeat();
      void releaseLease();
      setIsDriver(false);
    }

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

    // Seed DB status from the loaded row. The Realtime subscription will
    // keep these fresh from now on.
    setDbStatus(debate.status ?? (debate.is_complete ? 'complete' : 'idle'));
    setDbCurrentRound(debate.current_round ?? 0);
    setDbAwaitingHuman(debate.status === 'awaiting_human');
    setDbDriverSessionId(debate.driver_session_id ?? null);
    setDbDriverHeartbeatAt(debate.driver_heartbeat_at ?? null);
  }, [isDriver, stopHeartbeat, releaseLease]);

  const resetDebate = useCallback(() => {
    if (isDriver) {
      stopHeartbeat();
      void releaseLease();
    }
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
    setIsDriver(false);
    setDbStatus(null);
    setDbCurrentRound(0);
    setDbAwaitingHuman(false);
    setDbDriverSessionId(null);
    setDbDriverHeartbeatAt(null);
  }, [isDriver, stopHeartbeat, releaseLease]);

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

  /** Force-claim the lease from another tab and resume from the persisted
   *  state. The page should only call this when canTakeOver is true (the
   *  button is hidden otherwise). */
  const takeOverDebate = useCallback(async (): Promise<SubmitResult> => {
    if (!activeDebate) return { ok: false, error: 'No active debate' };
    if (isDriver) return { ok: false, error: 'You already control this debate' };

    // Force-claim regardless of heartbeat freshness — explicit user action.
    // The button visibility rules upstream (canTakeOver) already enforce
    // that this is only called when it's safe (awaiting_human or stale).
    const claim = await claimLease(0);
    if (!claim.claimed) {
      return {
        ok: false,
        error: claim.reason === 'rpc_error'
          ? 'Could not take over (database error).'
          : 'Could not take over the debate.',
      };
    }

    // We now hold the lease. Resume from the persisted DB state — this
    // will hit the same user_turn_needed event the previous tab was paused
    // on (if any), and the orchestrator will set pendingUserTurn for us.
    await continueDebate();

    return { ok: true };
  }, [activeDebate, isDriver, claimLease, continueDebate]);

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

  /** Follower mode: someone ELSE is currently driving this debate. The check
   *  is "live driver exists" rather than "status is running" so a stale-but-
   *  not-yet-released-on-unload lease still triggers it correctly only when
   *  there really is another active driver. */
  const isFollowing =
    !!activeDebate &&
    !generating &&
    !!dbDriverSessionId &&
    dbDriverSessionId !== tabIdRef.current &&
    (dbStatus === 'running' || dbStatus === 'awaiting_human');

  // Periodically re-evaluate whether the current driver lease is stale.
  // The DB heartbeat updates every 5s under normal operation, so a 5s
  // tick here gives a worst-case ~5s detection latency on top of the 15s
  // staleness threshold (total ~20s before take-over becomes available).
  useEffect(() => {
    if (!dbDriverHeartbeatAt) return;
    const id = setInterval(() => setStaleTick(t => t + 1), 5_000);
    return () => clearInterval(id);
  }, [dbDriverHeartbeatAt]);

  const dbDriverStale = useMemo(() => {
    if (!dbDriverSessionId || !dbDriverHeartbeatAt) return false;
    // Don't show "stale" for our own lease — we know we're alive.
    if (dbDriverSessionId === tabIdRef.current) return false;
    const ageMs = Date.now() - new Date(dbDriverHeartbeatAt).getTime();
    return ageMs > STALE_LEASE_THRESHOLD_SECS * 1000;
    // staleTick intentionally in deps so the memo re-evaluates on each tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbDriverSessionId, dbDriverHeartbeatAt, staleTick]);

  /** Should the take-over button be visible right now? Per Q1: only when
   *  the row is paused on a human turn (always allowed) OR the existing
   *  driver lease has gone stale. Hidden during active streaming with a
   *  fresh heartbeat — explicit interruption isn't worth the token cost
   *  of re-running the in-progress argument. */
  const canTakeOver = !!activeDebate
    && !isDriver
    && !generating
    && (
      (isFollowing && dbStatus === 'awaiting_human') ||
      dbDriverStale
    );

  const statusValue: StatusContextValue = {
    activeDebate,
    generating,
    error,
    errorReason,
    justCompleted,
    isDriver,
    dbStatus,
    dbCurrentRound,
    dbAwaitingHuman,
    isFollowing,
    dbDriverStale,
    canTakeOver,
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
    takeOverDebate,
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
