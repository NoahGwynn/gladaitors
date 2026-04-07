// ============================================================================
// Debate Arena — /arena/debate
// ============================================================================
// Two-panel layout: form (left) + debate thread (right).
// Streams responses via SSE as models argue sequentially.
// ============================================================================

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { config } from "@/lib/config";
import { createDebateRecord, updateDebateArguments, completeDebate, getUserDebates, deleteDebate } from "@/lib/debates";
import { createClient } from "@/lib/supabase";
import type { Debate } from "@/lib/types";
import type { DebateArgument } from "@/lib/types";
import ModelSelect from "@/components/ModelSelect";
import AuthModal from "@/components/AuthModal";
import { X, LockKeyhole, ChevronRight, Loader2 } from 'lucide-react';
import ShareMenu from '@/components/ShareMenu';
import ShareModal from '@/components/ShareModal';
import styles from "./page.module.scss";

const MODEL_COLOURS: Record<string, string> = {
  claude: "#7C3AED",
  gpt4o: "#10B981",
  gemini: "#3B82F6",
};

const MODEL_NAMES_MAP: Record<string, string> = {
  claude: "Claude",
  gpt4o: "GPT-4o",
  gemini: "Gemini",
};

function formatModelList(modelIds: string[]): string {
  const names = modelIds.map(id => MODEL_NAMES_MAP[id] || id);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface DebaterConfig {
  modelId: string;
  position: string;
}

interface LiveArgument extends DebateArgument {
  streaming: boolean;
}

export default function DebateArenaPage() {
  const [topic, setTopic] = useState("");
  const [debaters, setDebaters] = useState<DebaterConfig[]>([
    { modelId: "claude", position: "" },
    { modelId: "gpt4o", position: "" },
  ]);
  const [rounds, setRounds] = useState(3);
  const [context, setContext] = useState("");
  const [generating, setGenerating] = useState(false);
  const [finished, setFinished] = useState(false);
  const [liveArguments, setLiveArguments] = useState<LiveArgument[]>([]);
  const [currentThinking, setCurrentThinking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [debateId, _setDebateId] = useState<string | null>(null);
  const debateIdRef = useRef<string | null>(null);
  const savedRef = useRef(false);

  function setDebateId(id: string | null) {
    _setDebateId(id);
    debateIdRef.current = id;
  }
  const [showAuth, setShowAuth] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [history, setHistory] = useState<Debate[]>([]);
  const [viewingDebate, setViewingDebate] = useState<Debate | null>(null);
  const [activeDebateConfig, setActiveDebateConfig] = useState<{
    topic: string;
    debaters: DebaterConfig[];
  } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    const debates = await getUserDebates();
    setHistory(debates);
  }, []);

  // Track auth state + load history
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      setIsLoggedIn(!!user);
      if (user) {
        loadHistory().then(() => {
          // Check for incomplete debate to resume
          getUserDebates().then(debates => {
            const incomplete = debates.find(d => !d.is_complete && (d.arguments as unknown[]).length > 0);
            if (incomplete) {
              viewPastDebate(incomplete);
              setFinished(false);
            }
          });
        });
        setRounds(prev => prev === 3 ? 5 : prev);
      }
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setIsLoggedIn(!!session?.user);
      if (session?.user) {
        loadHistory();
        setRounds(prev => prev === 3 ? 5 : prev);
      } else {
        setHistory([]);
        setRounds(3);
      }
    });
    return () => subscription.unsubscribe();
  }, [loadHistory]);
  const activeRoundRef = useRef(1);
  const debateEndRef = useRef<HTMLDivElement>(null);
  const debatePanelRef = useRef<HTMLDivElement>(null);

  const cost = config.debateCost[rounds] || 10;
  const canAddModel = debaters.length < 3;
  const usedModels = new Set(debaters.map((d) => d.modelId));
  const availableModels = config.debateModels.filter((m) => !usedModels.has(m.id));
  const isValid =
    topic.trim().length > 0 && debaters.every((d) => d.position.trim().length > 0) && debaters.length >= 2;

  // Auto-scroll only when user is near the bottom of the debate panel
  const isNearBottomRef = useRef(true);
  useEffect(() => {
    const panel = debatePanelRef.current;
    if (!panel) return;
    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = panel;
      isNearBottomRef.current = scrollHeight - scrollTop - clientHeight < 150;
    };
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => panel.removeEventListener("scroll", onScroll);
  }, []);

  // Mark debate complete when finished
  useEffect(() => {
    if (!finished || savedRef.current || !debateIdRef.current || viewingDebate) return;
    savedRef.current = true;
    completeDebate(debateIdRef.current).then(() => {
      if (isLoggedIn) loadHistory();
    });
  }, [finished]); // eslint-disable-line react-hooks/exhaustive-deps

  const argCountRef = useRef(0);
  useEffect(() => {
    const newCount = liveArguments.length;
    const isNew = newCount !== argCountRef.current;
    argCountRef.current = newCount;
    if ((isNew || currentThinking) && isNearBottomRef.current && debateEndRef.current) {
      debateEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [liveArguments.length, currentThinking]);

  function updateDebater(index: number, field: keyof DebaterConfig, value: string) {
    setDebaters((prev) => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }

  function addDebater() {
    if (!canAddModel || availableModels.length === 0) return;
    setDebaters((prev) => [...prev, { modelId: availableModels[0].id, position: "" }]);
  }

  function removeDebater(index: number) {
    if (debaters.length <= 2) return;
    setDebaters((prev) => prev.filter((_, i) => i !== index));
  }

  async function continueDebate() {
    if (!viewingDebate || generating) return;

    // Figure out where we left off
    const existingArgs = liveArguments.filter(a => !a.streaming);
    const lastRound = existingArgs.length > 0 ? Math.max(...existingArgs.map(a => a.round)) : 0;

    // Count how many models have gone in the last round
    const modelsInLastRound = existingArgs.filter(a => a.round === lastRound).length;
    const allModelsWent = modelsInLastRound >= debaters.length;
    const startRound = allModelsWent ? lastRound + 1 : lastRound;
    const skipModels = allModelsWent ? 0 : modelsInLastRound;

    setGenerating(true);
    setViewingDebate(null);
    setError(null);
    setCurrentThinking(null);
    savedRef.current = false;

    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          debaters,
          rounds,
          context: context || undefined,
          // Pass existing arguments so the API can provide them as context
          existingArguments: existingArgs.map(a => ({
            model_id: a.model_id,
            model_name: a.model_name,
            round: a.round,
            content: a.content,
            refused: a.refused,
          })),
          startRound,
          skipModels,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        try {
          throw new Error(JSON.parse(text).error || 'Failed to continue debate');
        } catch {
          throw new Error(text || 'Failed to continue debate');
        }
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response stream');

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
              handleSSEEvent(eventType, JSON.parse(line.slice(6)));
            } catch { /* skip */ }
            eventType = '';
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setGenerating(false);
      setCurrentThinking(null);
    }
  }

  function clearForm() {
    setTopic('');
    setContext('');
    setDebaters([
      { modelId: 'claude', position: '' },
      { modelId: 'gpt4o', position: '' },
    ]);
    setRounds(isLoggedIn ? 5 : 3);
  }

  function resetDebate() {
    clearForm();
    setLiveArguments([]);
    setCurrentThinking(null);
    setError(null);
    setFinished(false);
    setDebateId(null);
    setViewingDebate(null);
    setActiveDebateConfig(null);
    savedRef.current = false;
    activeRoundRef.current = 1;
    argCountRef.current = 0;
  }

  function viewPastDebate(debate: Debate) {
    const args = debate.arguments as Array<DebateArgument>;
    isNearBottomRef.current = false;
    setLiveArguments(args.map((a) => ({ ...a, streaming: false })));
    setFinished(debate.is_complete);
    setDebateId(debate.id);
    setViewingDebate(debate);
    setCurrentThinking(null);
    setGenerating(false);
    setTimeout(() => {
      if (debatePanelRef.current) {
        debatePanelRef.current.scrollTop = 0;
      }
    }, 0);
  }

  async function generateDebate() {
    if (!isValid || generating) return;

    // Capture form values before clearing
    const debateTopic = topic;
    const debateDebaters = [...debaters];
    const debateRounds = rounds;
    const debateContext = context;

    setGenerating(true);
    setLiveArguments([]);
    setCurrentThinking(null);
    setError(null);
    setFinished(false);
    setDebateId(null);
    setViewingDebate(null);
    savedRef.current = false;
    activeRoundRef.current = 1;

    // Store the active debate config for display, then clear the form
    setActiveDebateConfig({ topic: debateTopic, debaters: debateDebaters });
    clearForm();

    // Create the debate record before streaming starts
    const positions: Record<string, string> = {};
    debateDebaters.forEach(d => { positions[d.modelId] = d.position; });
    const newId = await createDebateRecord({
      topic: debateTopic,
      positions,
      models: debateDebaters.map(d => d.modelId),
      rounds: debateRounds,
      context: debateContext || undefined,
    });
    if (newId) setDebateId(newId);

    try {
      const res = await fetch("/api/debate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: debateTopic, debaters: debateDebaters, rounds: debateRounds, context: debateContext || undefined }),
      });

      if (!res.ok) {
        const text = await res.text();
        try {
          throw new Error(JSON.parse(text).error || "Failed to generate debate");
        } catch {
          throw new Error(text || "Failed to generate debate");
        }
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            try {
              handleSSEEvent(eventType, JSON.parse(line.slice(6)));
            } catch {
              /* skip */
            }
            eventType = "";
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setGenerating(false);
      setCurrentThinking(null);
    }
  }

  function handleSSEEvent(event: string, data: Record<string, unknown>) {
    switch (event) {
      case "thinking":
        setCurrentThinking(data.model_name as string);
        activeRoundRef.current = (data.round as number) || activeRoundRef.current;
        break;

      case "token": {
        const modelId = data.model_id as string;
        const token = data.token as string;
        setLiveArguments((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.model_id === modelId && last.streaming) {
            const updated = [...prev];
            updated[updated.length - 1] = { ...last, content: last.content + token };
            return updated;
          } else {
            setCurrentThinking(null);
            return [
              ...prev,
              {
                model_id: modelId,
                model_name: MODEL_NAMES_MAP[modelId] || modelId,
                round: activeRoundRef.current,
                content: token,
                refused: false,
                streaming: true,
              },
            ];
          }
        });
        break;
      }

      case "argument": {
        const arg = data as unknown as DebateArgument;
        setLiveArguments((prev) => {
          const updated = [...prev];
          const idx = updated.findIndex((a) => a.model_id === arg.model_id && a.streaming);
          const final_: LiveArgument = { ...arg, streaming: false };
          if (idx >= 0) {
            updated[idx] = final_;
          } else {
            updated.push(final_);
          }
          // Save progress to database
          if (debateIdRef.current) {
            const completedArgs = updated.filter(a => !a.streaming).map(a => ({
              model_id: a.model_id,
              model_name: a.model_name,
              round: a.round,
              content: a.content,
              refused: a.refused,
              refusal_reason: a.refusal_reason,
            }));
            updateDebateArguments(debateIdRef.current, completedArgs);
          }
          return updated;
        });
        setCurrentThinking(null);
        break;
      }

      case "done":
        setFinished(true);
        setCurrentThinking(null);
        break;

      case "error":
        setError((data.message as string) || "An error occurred");
        break;
    }
  }

  // --- Render ---

  const hasDebate = liveArguments.length > 0 || currentThinking || generating;

  // Display data — viewed debate > active generating debate > form
  const displayTopic = viewingDebate?.topic || activeDebateConfig?.topic || topic;
  const displayPositions = viewingDebate
    ? viewingDebate.models.map(id => ({
        modelId: id,
        position: (viewingDebate.positions as Record<string, string>)[id] || '',
      }))
    : activeDebateConfig?.debaters || debaters;
  const displayModelIds = displayPositions.map(d => d.modelId);

  return (
    <div className={styles.page}>
      {/* Left panel: form */}
      <div className={styles.formPanel}>
        <span>
          <h1 className={styles.formTitle}>The Arena</h1>
          <p className={styles.formSubtitle}>Set the topic. Assign positions. Watch AI models debate.</p>
        </span>

        <div className={styles.field}>
          <label className={styles.label}>What should they debate?</label>
          <input
            className={styles.topicInput}
            type="text"
            placeholder="e.g. Is a banana a berry?"
            maxLength={config.maxTopicLength}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
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
                style={{ '--debater-colour': MODEL_COLOURS[debater.modelId] || '#888' } as React.CSSProperties}
              >
                <div className={styles.debaterHeader}>
                  <div className={styles.modelDot} style={{ background: MODEL_COLOURS[debater.modelId] || '#888' }} />
                  <ModelSelect
                    value={debater.modelId}
                    options={config.debateModels}
                    disabledIds={usedModels}
                    onChange={(id) => updateDebater(i, 'modelId', id)}
                    disabled={generating}
                  />
                  {debaters.length > 2 && !generating && (
                    <button className={styles.removeButton} onClick={() => removeDebater(i)}><X size={14} /></button>
                  )}
                </div>
                <input
                  className={styles.positionInput}
                  type="text"
                  placeholder="Their position..."
                  maxLength={config.maxPositionLength}
                  value={debater.position}
                  onChange={(e) => updateDebater(i, 'position', e.target.value)}
                  disabled={generating}
                />
              </div>
            ))}
            {canAddModel && availableModels.length > 0 && !generating && (
              isLoggedIn ? (
                <button className={styles.addModel} onClick={addDebater}>+ Add model</button>
              ) : (
                <button className={styles.lockedOption} onClick={() => setShowAuth(true)}>
                  + Add model <span className={styles.lockedBadge}>Sign up</span>
                </button>
              )
            )}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label}>Rounds</label>
            <div className={styles.roundSelector}>
              {[3, 5, 7].map((n) => {
                const locked = !isLoggedIn && n > 3;
                return (
                  <button
                    key={n}
                    className={`${styles.roundOption} ${rounds === n ? styles.roundOptionActive : ''} ${locked ? styles.roundOptionLocked : ''}`}
                    onClick={() => locked ? setShowAuth(true) : setRounds(n)}
                    disabled={generating}
                    title={locked ? 'Sign up to unlock more rounds' : undefined}
                  >
                    {n}
                    {locked && <LockKeyhole size={12} className={styles.lockIcon} />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <details className={styles.optionalSection}>
          <summary className={styles.optionalSummary}>
            <ChevronRight size={14} className={styles.detailsChevron} />
            Rules or context (optional)
          </summary>
          <textarea
            className={styles.textarea}
            placeholder="e.g. Scientific evidence only"
            maxLength={config.maxContextLength}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            disabled={generating}
          />
        </details>

        <div className={styles.submitRow}>
          <span className={styles.cost}>{cost} tokens</span>
          <button className={styles.submitButton} disabled={!isValid || generating} onClick={generateDebate}>
            {generating ? "Debating..." : "Start Debate"}
          </button>
        </div>

        {error && <p className={styles.error}>{error}</p>}

        {/* Debate history */}
        {isLoggedIn && history.length > 0 && (
          <div className={styles.historySection}>
            <div className={styles.historyHeader}>
              <span className={styles.label}>Your Debates</span>
            </div>
            <div className={styles.historyList}>
              {history.map((debate) => (
                <div
                  key={debate.id}
                  className={`${styles.historyItem} ${viewingDebate?.id === debate.id ? styles.historyItemActive : ""} ${generating ? styles.historyItemDisabled : ""}`}
                  onClick={() => !generating && viewPastDebate(debate)}
                >
                  {confirmDeleteId === debate.id ? (
                    <div className={styles.confirmDelete}>
                      <span>Delete this debate?</span>
                      <div className={styles.confirmDeleteActions}>
                        <button
                          className={styles.confirmYes}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteDebate(debate.id).then((ok) => {
                              if (ok) {
                                loadHistory();
                                if (viewingDebate?.id === debate.id) resetDebate();
                              }
                              setConfirmDeleteId(null);
                            });
                          }}
                        >
                          Delete
                        </button>
                        <button
                          className={styles.confirmNo}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(null);
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className={styles.historyItemRow}>
                        <span className={styles.historyTopic}>{debate.topic}</span>
                        <button
                          className={styles.historyDelete}
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeleteId(debate.id);
                          }}
                          title="Delete debate"
                        >
                          <X size={12} />
                        </button>
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
          </div>
        )}
      </div>

      {/* Right panel: debate thread */}
      <div className={styles.debatePanel} ref={debatePanelRef}>
        {!hasDebate ? (
          <div className={styles.debateEmpty}>
            <img src="/brand/icon.png" alt="" className={styles.emptyIcon} />
            <p className={styles.emptyText}>
              Configure your debate and press Start. Models will argue their positions in real time.
            </p>
          </div>
        ) : (
          <div className={styles.debateThread}>
            <div className={styles.debateHeader}>
              {debateId && (
                <div className={styles.headerShareIcon}>
                  <ShareMenu
                    url={`${typeof window !== 'undefined' ? window.location.origin : ''}/arena/debate/${debateId}`}
                    title={`AI Debate: ${displayTopic}`}
                    text={`Watch ${formatModelList(displayModelIds)} debate: "${displayTopic}"`}
                    variant="icon"
                  />
                </div>
              )}
              <h2 className={styles.debateTitle}>{displayTopic}</h2>
              <div className={styles.debatePositions}>
                {displayPositions.map(d => (
                  <span
                    key={d.modelId}
                    className={styles.debatePosition}
                    style={{ color: MODEL_COLOURS[d.modelId] || '#888' }}
                  >
                    {MODEL_NAMES_MAP[d.modelId] || d.modelId}: {d.position}
                  </span>
                ))}
              </div>
            </div>

            {Array.from(new Set(liveArguments.map((a) => a.round))).map((roundNum) => (
              <div key={roundNum}>
                <div className={styles.roundDivider}>
                  <span className={styles.roundLabel}>
                    {roundNum === 1
                      ? "Opening Statements"
                      : roundNum === Math.max(...liveArguments.map(a => a.round), 0)
                        ? "Closing Statements"
                        : `Round ${roundNum}`}
                  </span>
                </div>
                {liveArguments
                  .filter((a) => a.round === roundNum)
                  .map((arg, i) => (
                    <div
                      key={`${roundNum}-${arg.model_id}-${i}`}
                      className={`${styles.argument} ${arg.streaming ? styles.streaming : ""}`}
                      style={{ "--model-colour": MODEL_COLOURS[arg.model_id] || "#888" } as React.CSSProperties}
                    >
                      <div className={styles.argumentHeader}>
                        <span className={styles.argumentModel}>{arg.model_name}</span>
                        <span className={styles.argumentPosition}>
                          {debaters.find((d) => d.modelId === arg.model_id)?.position}
                        </span>
                        {arg.streaming && <span className={styles.streamingDot} />}
                      </div>
                      {arg.refused ? (
                        <p className={styles.refusal}>
                          Declined this position{arg.refusal_reason ? `: ${arg.refusal_reason}` : ""}
                        </p>
                      ) : (
                        <div className={styles.argumentContent}>
                          <ReactMarkdown>{arg.content}</ReactMarkdown>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            ))}

            {currentThinking && (
              <div className={styles.thinkingIndicator}>
                <Loader2 size={16} className={styles.spinner} />
                {currentThinking} is thinking...
              </div>
            )}

            {finished && (
              <div className={styles.postDebate}>
                <span className={styles.postDebateText}>
                  Debate complete — {Math.max(...liveArguments.map(a => a.round), 0)} rounds, {liveArguments.length} arguments
                </span>

                {!isLoggedIn && (
                  <div className={styles.savePrompt}>
                    <span>This debate expires in 30 days.</span>
                    <button className={styles.saveButton} onClick={() => setShowAuth(true)}>
                      Sign up to save permanently
                    </button>
                  </div>
                )}

                {debateId && (
                  <button
                    className={styles.shareButton}
                    onClick={() => setShowShareModal(true)}
                  >
                    Share This Debate
                  </button>
                )}

                <div className={styles.postDebateActions}>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => {
                      const text = liveArguments
                        .map((a) => `**${a.model_name}** (Round ${a.round}):\n${a.content}`)
                        .join("\n\n---\n\n");
                      navigator.clipboard.writeText(`# ${topic}\n\n${text}`);
                    }}
                  >
                    Copy Text
                  </button>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => {
                      resetDebate();
                      generateDebate();
                    }}
                  >
                    Run Again
                  </button>
                  <button className={styles.secondaryButton} onClick={resetDebate}>
                    New Debate
                  </button>
                </div>
              </div>
            )}

            {viewingDebate && !viewingDebate.is_complete && !generating && !finished && (
              <div className={styles.continueDebate}>
                <p className={styles.continueText}>
                  This debate was interrupted — {liveArguments.length} of {rounds * debaters.length} arguments completed.
                </p>
                <button
                  className={styles.submitButton}
                  onClick={() => continueDebate()}
                >
                  Continue Debate
                </button>
              </div>
            )}

            <div ref={debateEndRef} />
          </div>
        )}
      </div>

      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onSuccess={() => setShowAuth(false)}
          initialMode="signup"
          message="Sign up to save this debate permanently"
        />
      )}

      {showShareModal && debateId && (
        <ShareModal
          url={`${window.location.origin}/arena/debate/${debateId}`}
          topic={displayTopic}
          modelNames={displayPositions.map(d => MODEL_NAMES_MAP[d.modelId] || d.modelId)}
          onClose={() => setShowShareModal(false)}
        />
      )}
    </div>
  );
}
