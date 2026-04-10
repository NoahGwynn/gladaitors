// ============================================================================
// Territory War — /arena/territory-war
// ============================================================================
// Structured challenge where AI models compete for territory on a 30×30
// grid. The lab value is in the strategy feedback panel: stated reasoning
// alongside actual actions, with alignment indicators showing the gap
// between what models say they'll do and what they actually do.
//
// Layout: model picker → map (CSS grid) + strategy feedback (three columns)
// Data: SSE from POST /api/challenges/territory-war
// ============================================================================

'use client';

import { useState, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { getSessionId } from '@/lib/debates';
import { getModelColour, getModelName, findModel, MODELS } from '@/lib/models';
import { applyActions } from '@/lib/challenges/territory-war/actions';
import { advanceTick, updateTerritory } from '@/lib/challenges/territory-war/scoring';
import type { ChallengeState, PieceAction, ChallengeEvent } from '@/lib/challenges/territory-war/types';
import styles from './page.module.scss';

// Phaser requires DOM — dynamic import with ssr: false
const TerritoryWarCanvas = dynamic(
  () => import('@/lib/challenges/territory-war/phaser/TerritoryWarCanvas'),
  { ssr: false },
);

// --- Types for SSE events ---

interface TurnActions {
  tick: number;
  model: string;
  modelId: string;
  actions: PieceAction[];
  events: ChallengeEvent[];
  error?: string | null;
}

interface TurnLog {
  tick: number;
  models: TurnActions[];
}

// --- Only AI models (no human, no user) for Territory War ---
const TW_MODELS = MODELS.filter(m => m.family !== 'user');

export default function TerritoryWarPage() {
  // --- Form state ---
  const [selectedModels, setSelectedModels] = useState<string[]>([
    'claude-sonnet', 'gpt-4o', 'gemini-flash',
  ]);

  // --- Challenge state ---
  const [challengeState, setChallengeState] = useState<ChallengeState | null>(null);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentTurn, setCurrentTurn] = useState<TurnActions | null>(null);
  const [turnLog, setTurnLog] = useState<TurnLog[]>([]);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [thinkingModel, setThinkingModel] = useState<string | null>(null);
  const [winner, setWinner] = useState<string | null>(null);
  const [lastActions, setLastActions] = useState<{ model: string; actions: PieceAction[] } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Build Phaser colour map from selected model IDs → model display names
  // The Phaser scene keys colours by display name (e.g. "Claude Sonnet")
  const colourMap: Record<string, number> = {};
  for (const id of selectedModels) {
    const name = getModelName(id);
    // Convert CSS hex string (#D97757) to Phaser number (0xD97757)
    const hex = getModelColour(id);
    colourMap[name] = parseInt(hex.replace('#', ''), 16);
  }

  // --- Model picker helpers ---
  function toggleModel(id: string) {
    setSelectedModels(prev => {
      if (prev.includes(id)) {
        if (prev.length <= 2) return prev; // minimum 2
        return prev.filter(m => m !== id);
      }
      if (prev.length >= 4) return prev; // maximum 4
      return [...prev, id];
    });
  }

  // --- Start the challenge ---
  const startChallenge = useCallback(async () => {
    if (running || selectedModels.length < 2) return;

    setRunning(true);
    setFinished(false);
    setError(null);
    setChallengeState(null);
    setTurnLog([]);
    setCurrentTurn(null);
    setThinkingModel(null);
    setWinner(null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      const sid = getSessionId();
      if (sid) headers['x-session-id'] = sid;

      const res = await fetch('/api/challenges/territory-war', {
        method: 'POST',
        headers,
        body: JSON.stringify({ models: selectedModels }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to start challenge');
        setRunning(false);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) {
        setError('No response stream');
        setRunning(false);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';
      let currentTickLog: TurnLog = { tick: 0, models: [] };

      // We keep a mutable local copy of the state so we can apply
      // actions immediately without waiting for the full-state
      // tick_complete event (which is ~100KB and can get lost in
      // chunk splitting). The React state is updated from this copy.
      let localState: ChallengeState | null = null;

      // Process a complete SSE event (after \n\n boundary is found)
      function processEvent(eventType: string, dataStr: string) {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(dataStr);
        } catch {
          return; // malformed JSON — skip
        }

        switch (eventType) {
          case 'challenge_started':
            setChallengeId((data.challengeId || data.gameId) as string);
            localState = data.state as ChallengeState;
            setChallengeState({ ...localState });
            break;

          case 'turn_start':
            setThinkingModel(data.model as string);
            break;

          case 'turn_actions': {
            const actions = (data.actions || []) as PieceAction[];
            const modelName = data.model as string;
            console.log(`[TW] turn_actions: ${modelName}, ${actions.length} actions`, actions.map(a => `${a.action}${a.reasoning ? ` — "${a.reasoning}"` : ''}`));

            // Apply actions to local state so the grid updates
            // immediately — don't wait for tick_complete
            if (localState && actions.length > 0) {
              applyActions(localState, modelName, actions);
              // Update territory immediately so tile colours change
              // as pieces move (not just at tick end)
              updateTerritory(localState);
              setChallengeState({ ...localState });
              // Trigger Phaser animations for this model's actions
              setLastActions({ model: modelName, actions });
            }

            const turnActions: TurnActions = {
              tick: data.tick as number,
              model: modelName,
              modelId: data.modelId as string,
              actions,
              events: (data.events || []) as ChallengeEvent[],
              error: (data.error as string) || undefined,
            };
            setCurrentTurn(turnActions);
            setThinkingModel(null);

            // Accumulate into tick log
            if (currentTickLog.tick !== data.tick) {
              if (currentTickLog.models.length > 0) {
                setTurnLog(prev => [...prev, currentTickLog]);
              }
              currentTickLog = { tick: data.tick as number, models: [turnActions] };
            } else {
              currentTickLog.models.push(turnActions);
            }
            break;
          }

          case 'tick_complete':
            // Advance the local state (territory claiming, dead
            // piece removal, win check) — mirrors the server's
            // advanceTick call
            if (localState) {
              advanceTick(localState);
              setChallengeState({ ...localState });
            }

            // Flush the current tick log
            if (currentTickLog.models.length > 0) {
              setTurnLog(prev => [...prev, currentTickLog]);
              currentTickLog = { tick: ((data.tick as number) || 0) + 1, models: [] };
            }
            break;

          case 'challenge_complete':
            setFinished(true);
            setWinner((data.winner as string) || null);
            break;

          case 'error':
            setError((data.message as string) || 'An error occurred');
            break;
        }
      }

      // Proper SSE parser: accumulate text until a complete event
      // (terminated by \n\n) is found, then process it. This handles
      // large payloads that span multiple read() chunks.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process all complete events in the buffer
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          // Parse the event block
          let eventType = '';
          let dataStr = '';
          for (const line of rawEvent.split('\n')) {
            if (line.startsWith('event: ')) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              dataStr += line.slice(6);
            }
          }

          if (eventType && dataStr) {
            processEvent(eventType, dataStr);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message || 'Connection error');
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [running, selectedModels]);

  // --- Derive display info ---
  const modelNames = selectedModels.map(id => getModelName(id));
  const tick = challengeState?.tick ?? 0;
  const maxTicks = challengeState?.maxTicks ?? 100;

  return (
    <div className={styles.page}>
      {/* ================================================================ */}
      {/* Setup (visible when no challenge is running) */}
      {/* ================================================================ */}
      {!challengeState && !running && (
        <div className={styles.setup}>
          <h1 className={styles.setupTitle}>Territory War</h1>
          <p className={styles.setupSubtitle}>
            Watch AI models compete for territory on a 30×30 grid. Observe their stated
            reasoning alongside their actual moves.
          </p>

          <div className={styles.modelPicker}>
            <label className={styles.label}>Pick 2-4 models</label>
            <div className={styles.modelGrid}>
              {TW_MODELS.map(model => {
                const selected = selectedModels.includes(model.id);
                return (
                  <button
                    key={model.id}
                    className={`${styles.modelChip} ${selected ? styles.modelChipSelected : ''}`}
                    style={{ '--model-colour': getModelColour(model.id) } as React.CSSProperties}
                    onClick={() => toggleModel(model.id)}
                  >
                    <span
                      className={styles.modelDot}
                      style={{ background: getModelColour(model.id) }}
                    />
                    {model.name}
                    {model.version && <span className={styles.modelVersion}> {model.version}</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            className={styles.startButton}
            onClick={startChallenge}
            disabled={selectedModels.length < 2}
          >
            Run Challenge ({selectedModels.length} models)
          </button>

          {error && <p className={styles.error}>{error}</p>}
        </div>
      )}

      {/* ================================================================ */}
      {/* Running / Complete view */}
      {/* ================================================================ */}
      {(challengeState || running) && (
        <>
          {/* Header bar */}
          <div className={styles.header}>
            <h2 className={styles.headerTitle}>Territory War</h2>
            <span className={styles.headerTick}>
              Turn {tick} / {maxTicks}
              {finished && winner && ` — ${winner} wins`}
              {finished && !winner && ' — Draw'}
            </span>
          </div>

          <div className={styles.mainLayout}>
            {/* Map */}
            <div className={styles.mapContainer}>
              <TerritoryWarCanvas
                state={challengeState}
                colourMap={colourMap}
                lastActions={lastActions}
                winner={winner}
              />

              {/* Loading state */}
              {running && !challengeState && (
                <div className={styles.loading}>Setting up challenge...</div>
              )}
            </div>

            {/* Strategy feedback panel */}
            <div className={styles.feedbackPanel}>
              {/* Model score cards */}
              {challengeState && (
                <div className={styles.scoreCards}>
                  {Object.entries(challengeState.models).map(([name, model], idx) => {
                    const colour = getModelColour(selectedModels[idx] || '');
                    const isThinking = thinkingModel === name;
                    return (
                      <div
                        key={name}
                        className={`${styles.scoreCard} ${model.eliminated ? styles.scoreCardEliminated : ''}`}
                        style={{ borderColor: colour }}
                      >
                        <div className={styles.scoreCardHeader}>
                          <span className={styles.scoreCardDot} style={{ background: colour }} />
                          <span className={styles.scoreCardName}>{name}</span>
                          {model.eliminated && <span className={styles.badge}>Eliminated</span>}
                          {isThinking && <span className={styles.badgeThinking}>Thinking...</span>}
                        </div>
                        <div className={styles.scoreCardStats}>
                          <span>Ore: {model.ore}</span>
                          <span>Food: {model.food}</span>
                          <span>Pieces: {challengeState.pieces.filter(p => p.modelName === name).length}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Turn-by-turn action log */}
              <div className={styles.turnLog}>
                <h3 className={styles.turnLogTitle}>Turn Log</h3>
                <div className={styles.turnLogScroll}>
                  {turnLog.map((tl, ti) => (
                    <div key={ti} className={styles.turnEntry}>
                      <span className={styles.turnLabel}>Turn {tl.tick}</span>
                      {tl.models.map((ta, mi) => {
                        const colour = getModelColour(
                          selectedModels[
                            Object.keys(challengeState?.models || {}).indexOf(ta.model)
                          ] || ''
                        );
                        return (
                          <div key={mi} className={styles.modelTurn} style={{ borderLeftColor: colour }}>
                            <span className={styles.modelTurnName} style={{ color: colour }}>
                              {ta.model}
                            </span>
                            {ta.error && (
                              <span className={styles.modelTurnError}>Error: {ta.error}</span>
                            )}
                            {ta.actions.map((a, ai) => (
                              <div key={ai} className={styles.actionEntry}>
                                <span className={styles.actionType}>{a.action}</span>
                                {a.direction && <span className={styles.actionDetail}>{a.direction}</span>}
                                {a.targetId != null && <span className={styles.actionDetail}>→ #{a.targetId}</span>}
                                {a.targetX != null && a.targetY != null && (
                                  <span className={styles.actionDetail}>→ ({a.targetX},{a.targetY})</span>
                                )}
                                {a.reasoning && (
                                  <span className={styles.actionReasoning}>{a.reasoning}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  ))}

                  {/* Current thinking indicator */}
                  {thinkingModel && (
                    <div className={styles.thinking}>
                      {thinkingModel} is thinking...
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>

          {error && <p className={styles.error}>{error}</p>}
        </>
      )}
    </div>
  );
}
