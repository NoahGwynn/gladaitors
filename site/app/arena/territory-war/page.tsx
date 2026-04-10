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
import { getSessionId } from '@/lib/debates';
import { getModelColour, getModelName, findModel, MODELS } from '@/lib/models';
import { GRID_SIZE } from '@/lib/challenges/territory-war/constants';
import type { ChallengeState, PieceAction, ChallengeEvent } from '@/lib/challenges/territory-war/types';
import styles from './page.module.scss';

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

  const abortRef = useRef<AbortController | null>(null);

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

              switch (eventType) {
                case 'challenge_started':
                  setChallengeId(data.challengeId || data.gameId);
                  setChallengeState(data.state as ChallengeState);
                  break;

                case 'turn_start':
                  setThinkingModel(data.model);
                  break;

                case 'turn_actions': {
                  const turnActions: TurnActions = {
                    tick: data.tick,
                    model: data.model,
                    modelId: data.modelId,
                    actions: data.actions || [],
                    events: data.events || [],
                    error: data.error,
                  };
                  setCurrentTurn(turnActions);
                  setThinkingModel(null);

                  // Accumulate into tick log
                  if (currentTickLog.tick !== data.tick) {
                    if (currentTickLog.models.length > 0) {
                      setTurnLog(prev => [...prev, currentTickLog]);
                    }
                    currentTickLog = { tick: data.tick, models: [turnActions] };
                  } else {
                    currentTickLog.models.push(turnActions);
                  }
                  break;
                }

                case 'tick_complete':
                  // Flush the current tick log
                  if (currentTickLog.models.length > 0) {
                    setTurnLog(prev => [...prev, currentTickLog]);
                    currentTickLog = { tick: (data.tick || 0) + 1, models: [] };
                  }
                  // Update state from the latest persisted state
                  if (data.state) {
                    setChallengeState(data.state as ChallengeState);
                  }
                  break;

                case 'challenge_complete':
                  setFinished(true);
                  setWinner(data.winner || null);
                  break;

                case 'error':
                  setError(data.message || 'An error occurred');
                  break;
              }
            } catch { /* skip malformed */ }
            eventType = '';
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
              {challengeState && (
                <div
                  className={styles.grid}
                  style={{
                    gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)`,
                    gridTemplateRows: `repeat(${GRID_SIZE}, 1fr)`,
                  }}
                >
                  {challengeState.grid.flat().map((tile, i) => {
                    const piece = challengeState.pieces.find(
                      p => p.x === tile.x && p.y === tile.y
                    );
                    const ownerColour = tile.owner
                      ? getModelColour(
                          selectedModels[
                            Object.keys(challengeState.models).indexOf(tile.owner)
                          ] || ''
                        )
                      : undefined;

                    return (
                      <div
                        key={i}
                        className={`${styles.tile} ${styles[`tile_${tile.tileType}`] || ''}`}
                        style={ownerColour ? {
                          backgroundColor: ownerColour,
                          opacity: tile.tileType === 'base' ? 0.8
                            : tile.tileType === 'fort' ? 0.6 : 0.25,
                        } : undefined}
                        title={`(${tile.x},${tile.y}) ${tile.tileType}${tile.owner ? ` — ${tile.owner}` : ''}${tile.resourceAmount ? ` [${tile.resourceAmount}]` : ''}`}
                      >
                        {tile.tileType === 'ore' && !tile.owner && (
                          <span className={styles.resourceIcon}>⛏</span>
                        )}
                        {tile.tileType === 'food' && !tile.owner && (
                          <span className={styles.resourceIcon}>🌾</span>
                        )}
                        {tile.tileType === 'base' && (
                          <span className={styles.resourceIcon}>🏰</span>
                        )}
                        {tile.tileType === 'fort' && (
                          <span className={styles.resourceIcon}>🛡</span>
                        )}
                        {piece && (
                          <div
                            className={styles.piece}
                            style={{
                              backgroundColor: getModelColour(
                                selectedModels[
                                  Object.keys(challengeState.models).indexOf(piece.modelName)
                                ] || ''
                              ),
                            }}
                            title={`${piece.modelName} #${piece.id} (${piece.hp} HP)`}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

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
