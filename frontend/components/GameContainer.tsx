// ============================================================================
// GameContainer — 'use client' component that owns Phaser + WebSocket
// ============================================================================

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { ChallengeType, ModelState } from '@/lib/types';
import { useGameSocket } from '@/lib/websocket';
import { GAME_STATE_UPDATE, GAME_OVER } from '@/phaser/events';
import GameHeader from './GameHeader';
import SidePanel from './SidePanel';
import type { ActionEntry } from './ActionFeed';
import EventLog from './EventLog';
import EventBanner from './EventBanner';
import styles from './GameContainer.module.scss';

interface GameContainerProps {
  challengeType: ChallengeType;
  episodeTitle: string;
  wsUrl: string;
}

/** Parse a model's last_action string into structured action entries */
function parseActions(lastAction: string): ActionEntry['actions'] {
  if (!lastAction || lastAction === 'Deciding next move...') {
    return [];
  }

  return lastAction.split(' | ').map((part) => {
    const dashIdx = part.indexOf(' \u2014 ');
    const emIdx = dashIdx >= 0 ? dashIdx : part.indexOf(' — ');
    if (emIdx >= 0) {
      const actionPart = part.substring(0, emIdx).trim();
      const reasoning = part.substring(emIdx + 3).trim();
      const spaceIdx = actionPart.indexOf(' ');
      return {
        type: spaceIdx >= 0 ? actionPart.substring(0, spaceIdx) : actionPart,
        detail: spaceIdx >= 0 ? actionPart.substring(spaceIdx + 1) : '',
        reasoning,
      };
    }
    const spaceIdx = part.indexOf(' ');
    return {
      type: spaceIdx >= 0 ? part.substring(0, spaceIdx) : part,
      detail: spaceIdx >= 0 ? part.substring(spaceIdx + 1) : '',
      reasoning: '',
    };
  });
}

export default function GameContainer({
  challengeType,
  episodeTitle,
  wsUrl,
}: GameContainerProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<unknown>(null);
  const { gameState, connected } = useGameSocket(wsUrl);
  const [phaserReady, setPhaserReady] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [bannerKey, setBannerKey] = useState(0);
  const [actionHistory, setActionHistory] = useState<ActionEntry[]>([]);

  // --- Mount Phaser ---
  useEffect(() => {
    if (!canvasRef.current) return;
    let destroyed = false;
    setPhaserReady(false);

    async function initPhaser() {
      const { createGame } = await import('@/phaser/game');
      const { default: TerritoryWarScene } = await import('@/phaser/scenes/TerritoryWarScene');
      const { default: TradingPitScene } = await import('@/phaser/scenes/TradingPitScene');
      if (destroyed || !canvasRef.current) return;

      const sceneMap = { territory_war: TerritoryWarScene, trading_pit: TradingPitScene } as const;
      const game = createGame(canvasRef.current, sceneMap[challengeType]);
      gameRef.current = game;
      setPhaserReady(true);
    }

    initPhaser().catch((err) => console.error('Phaser init failed:', err));

    return () => {
      destroyed = true;
      if (gameRef.current) {
        (gameRef.current as { destroy: (b: boolean) => void }).destroy(true);
        gameRef.current = null;
      }
    };
  }, [challengeType]);

  // Model ID map: display name → frontend id
  const modelIdMap = useRef<Record<string, string>>({});

  // --- Build action feed entries from game state ---
  // Uses only the prev state array as source of truth — no external refs
  const processGameState = useCallback((
    models: ModelState[],
    tick: number,
    canvasData: Record<string, unknown>,
  ) => {
    for (const m of models) {
      modelIdMap.current[m.name] = m.id;
    }

    const actionsTaken = canvasData.actions_taken as {
      model: string;
      actions: Array<{ action: string; direction?: string; reasoning?: string }>;
    } | undefined;

    // Simultaneous mode: all models' actions arrive at once
    const actionsTakenAll = canvasData.actions_taken_all as
      Record<string, Array<{ action: string; direction?: string; reasoning?: string }>> | undefined;

    const thinkingModel = models.find(m => m.status === 'thinking');
    const allThinking = models.every(m => m.status === 'thinking');

    setActionHistory(prev => {
      const updated = [...prev];
      let changed = false;

      // 1. FIRST: replace completed model's thinking entry with actions
      //    (must happen before adding new thinking entries)
      if (actionsTaken && actionsTaken.actions) {
        const modelId = modelIdMap.current[actionsTaken.model] || actionsTaken.model.toLowerCase();

        const actions = actionsTaken.actions.map(a => ({
          type: a.action || '?',
          detail: (a.direction as string) || '',
          reasoning: (a.reasoning as string) || '',
        }));

        const thinkingIdx = updated.findIndex(
          e => e.modelId === modelId && e.status === 'thinking'
        );

        if (thinkingIdx >= 0) {
          updated[thinkingIdx] = {
            ...updated[thinkingIdx],
            status: 'active',
            actions,
            round: tick,
          };
        } else {
          updated.push({
            id: `${Date.now()}-${modelId}`,
            modelId,
            modelName: actionsTaken.model,
            round: tick,
            status: 'active',
            actions,
          });
        }
        changed = true;
      }

      // 2b. Simultaneous mode — all models' actions arrive at once
      if (actionsTakenAll) {
        for (const [modelName, modelActions] of Object.entries(actionsTakenAll)) {
          const modelId = modelIdMap.current[modelName] || modelName.toLowerCase();
          const actions = (modelActions || []).map((a: { action?: string; direction?: string; reasoning?: string; asset?: string; amount?: number }) => ({
            type: a.action || '?',
            detail: a.asset ? `${a.asset} £${a.amount || 0}` : ((a.direction as string) || ''),
            reasoning: (a.reasoning as string) || '',
          }));

          const thinkingIdx = updated.findIndex(
            e => e.modelId === modelId && e.status === 'thinking'
          );

          if (thinkingIdx >= 0) {
            updated[thinkingIdx] = {
              ...updated[thinkingIdx],
              status: 'active',
              actions,
              round: tick,
            };
          } else {
            updated.push({
              id: `${Date.now()}-${modelId}-sim`,
              modelId,
              modelName: modelName,
              round: tick,
              status: 'active',
              actions,
            });
          }
          changed = true;
        }
      }

      // 3. Handle errors
      for (const model of models) {
        if (model.status === 'timeout' || model.status === 'invalid' || model.status === 'rate_limited') {
          const thinkingIdx = updated.findIndex(
            e => e.modelId === model.id && e.status === 'thinking'
          );
          if (thinkingIdx >= 0) {
            updated[thinkingIdx] = {
              ...updated[thinkingIdx],
              status: 'skip',
              error: model.status,
            };
            changed = true;
          }
        }
      }

      // 4. LAST: add thinking entries for models currently thinking
      //    (after replacements so we don't interfere with them)
      if (allThinking) {
        for (const model of models) {
          const alreadyThinking = updated.some(
            e => e.modelId === model.id && e.status === 'thinking'
          );
          if (!alreadyThinking) {
            updated.push({
              id: `${Date.now()}-${model.id}`,
              modelId: model.id,
              modelName: model.name,
              round: tick + 1,
              status: 'thinking',
              actions: [],
            });
            changed = true;
          }
        }
      } else if (thinkingModel) {
        const alreadyThinking = updated.some(
          e => e.modelId === thinkingModel.id && e.status === 'thinking'
        );
        if (!alreadyThinking) {
          updated.push({
            id: `${Date.now()}-${thinkingModel.id}`,
            modelId: thinkingModel.id,
            modelName: thinkingModel.name,
            round: tick + 1,
            status: 'thinking',
            actions: [],
          });
          changed = true;
        }
      }

      return changed ? updated : prev;
    });
  }, []);

  // --- Pipe game state to Phaser + process actions ---
  useEffect(() => {
    if (!gameState) return;

    // Pipe to Phaser
    const game = gameRef.current as { events: { emit: (e: string, d: unknown) => void } } | null;
    if (game && phaserReady && gameState.canvas_data) {
      game.events.emit(GAME_STATE_UPDATE, gameState.canvas_data);
      if (gameState.tick >= gameState.max_ticks && gameState.max_ticks > 0) {
        game.events.emit(GAME_OVER, gameState.canvas_data);
      }
    }

    // Build action history
    const cd = gameState.canvas_data || {};
    const thinking = gameState.models.find(m => m.status === 'thinking');
    const at = (cd as Record<string, unknown>).actions_taken;
    console.log(`[Feed] tick=${gameState.tick} thinking=${thinking?.name || 'none'} actions_taken=${at ? JSON.stringify(at).substring(0, 100) : 'none'}`);
    processGameState(gameState.models, gameState.tick, cd);

    // Banner events — only show scripted events (not routine game events like move_blocked)
    const bannerEvents = gameState.events.filter(e =>
      e.tick === gameState.tick &&
      e.message &&
      !e.message.includes('blocked') &&
      !e.message.includes('failed') &&
      !e.message.includes('attempted')
    );
    if (bannerEvents.length > 0) {
      setBannerMessage(bannerEvents[0].message);
      setBannerKey(prev => prev + 1);
    }
  }, [gameState, phaserReady, processGameState]);

  // Clear action history when game reloads
  useEffect(() => {
    if (gameState && gameState.tick === 0) {
      setActionHistory([]);
    }
  }, [gameState?.tick]);

  const metricMax = challengeType === 'territory_war' ? 240 : 15000;

  return (
    <div className={styles.container}>
      <GameHeader
        episodeTitle={episodeTitle}
        tick={gameState?.tick ?? 0}
        maxTicks={gameState?.max_ticks ?? 0}
        elapsedSeconds={gameState?.elapsed_seconds ?? 0}
      />

      <EventBanner message={bannerMessage} eventKey={bannerKey} />

      <div className={styles.gameArea}>
        <div className={styles.canvasWrapper} ref={canvasRef} />

        <SidePanel
          models={gameState?.models ?? []}
          actionHistory={actionHistory}
        />
      </div>

      <EventLog events={gameState?.events ?? []} />
    </div>
  );
}
