// ============================================================================
// GameContainer — 'use client' component that owns Phaser + WebSocket
// ============================================================================
// This is the central orchestrator for the game view:
//   1. Connects to backend via WebSocket (useGameSocket hook)
//   2. Mounts the Phaser game canvas via useRef
//   3. Pipes game state to React components (panels, header, event log)
//   4. Pipes canvas_data to Phaser scene via game.events EventEmitter
//
// IMPORTANT: Phaser useEffect must always clean up with game.destroy(true)
// to prevent duplicate instances on hot reload (CLAUDE.md key rule).
//
// Phaser is dynamically imported to avoid SSR issues (navigator not defined).
// ============================================================================

'use client';

import { useEffect, useRef, useState } from 'react';
import type { ChallengeType } from '@/lib/types';
import { useGameSocket } from '@/lib/websocket';
import { GAME_STATE_UPDATE, GAME_OVER } from '@/phaser/events';
import GameHeader from './GameHeader';
import ModelPanelList from './ModelPanelList';
import EventLog from './EventLog';
import EventBanner from './EventBanner';
import styles from './GameContainer.module.scss';

interface GameContainerProps {
  challengeType: ChallengeType;
  episodeTitle: string;
  wsUrl: string;
}

export default function GameContainer({
  challengeType,
  episodeTitle,
  wsUrl,
}: GameContainerProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<unknown>(null);
  const { gameState } = useGameSocket(wsUrl);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [bannerKey, setBannerKey] = useState(0);

  // --- Mount Phaser (dynamic import to avoid SSR navigator error) ---
  useEffect(() => {
    if (!canvasRef.current) return;

    let destroyed = false;

    async function initPhaser() {
      // Dynamic imports — Phaser requires browser globals
      const { createGame } = await import('@/phaser/game');
      const { default: TerritoryWarScene } = await import('@/phaser/scenes/TerritoryWarScene');
      const { default: TradingPitScene } = await import('@/phaser/scenes/TradingPitScene');

      if (destroyed || !canvasRef.current) return;

      const sceneMap = {
        territory_war: TerritoryWarScene,
        trading_pit: TradingPitScene,
      } as const;

      const SceneClass = sceneMap[challengeType];
      const game = createGame(canvasRef.current, SceneClass);
      gameRef.current = game;
    }

    initPhaser();

    // CRITICAL: destroy on cleanup to prevent duplicates on hot reload
    return () => {
      destroyed = true;
      if (gameRef.current) {
        (gameRef.current as { destroy: (removeCanvas: boolean) => void }).destroy(true);
        gameRef.current = null;
      }
    };
  }, [challengeType]);

  // --- Pipe game state to Phaser ---
  useEffect(() => {
    const game = gameRef.current as { events: { emit: (event: string, data: unknown) => void } } | null;
    if (!game || !gameState) return;

    if (gameState.canvas_data) {
      game.events.emit(GAME_STATE_UPDATE, gameState.canvas_data);
    }

    if (gameState.tick >= gameState.max_ticks) {
      game.events.emit(GAME_OVER, gameState.canvas_data);
    }

    // Check for banner-worthy events (scripted events this tick)
    const scriptedEvents = gameState.events.filter(
      e => e.tick === gameState.tick
    );
    if (scriptedEvents.length > 0) {
      setBannerMessage(scriptedEvents[0].message);
      setBannerKey(prev => prev + 1);
    }
  }, [gameState]);

  // Determine metric max for progress bars
  const metricMax = challengeType === 'territory_war' ? 100 : 15000;

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

        <ModelPanelList
          models={gameState?.models ?? []}
          metricMax={metricMax}
        />
      </div>

      <EventLog events={gameState?.events ?? []} />
    </div>
  );
}
