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
  getUserDebates, deleteDebate,
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
    loadDebate(debate);
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
    const debateContext = context;
    const debateReveal = revealIdentities;

    isNearBottomRef.current = true;
    argCountRef.current = 0;
    clearForm();

    await startDebate({
      topic: debateTopic,
      debaters: debateDebaters,
      rounds: debateRounds,
      context: debateContext,
      revealIdentities: debateReveal,
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
      {/* RIGHT PANEL: Debate thread                                       */}
      {/* ================================================================ */}
      <div className={styles.debatePanel} ref={debatePanelRef}>
        {/* Mobile: back to form */}
        {hasDebate && !generating && (
          <button
            className={styles.mobileBackButton}
            onClick={() => resetDebate()}
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
