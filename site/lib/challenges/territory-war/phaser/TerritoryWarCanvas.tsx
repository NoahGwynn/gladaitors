// ============================================================================
// TerritoryWarCanvas — React wrapper for the Phaser scene
// ============================================================================
// Mounts a Phaser game instance inside a ref'd div and bridges
// ChallengeState + PieceAction updates from the page into the Phaser
// scene via game-level events.
//
// MUST be imported with next/dynamic({ ssr: false }) because Phaser
// requires the DOM.
// ============================================================================

'use client';

import { useEffect, useRef } from 'react';
import * as Phaser from 'phaser';
import TerritoryWarScene from './TerritoryWarScene';
import { TW_STATE_UPDATE, TW_ACTIONS, TW_GAME_OVER } from './events';
import type { ChallengeState, PieceAction } from '../types';

// --- Adapter: convert ChallengeState → Phaser scene data shapes ---

function stateToSceneData(state: ChallengeState, colourMap: Record<string, number>) {
  // Grid: convert Tile[][] → TileData[][]
  const grid = state.grid.map(row =>
    row.map(tile => ({
      x: tile.x,
      y: tile.y,
      type: tile.tileType,
      owner: tile.owner,
      resources: tile.resourceAmount,
      fort_hp: tile.fortHp,
    }))
  );

  // Pieces: convert Piece[] → PieceData[]
  const pieces = state.pieces.map(p => ({
    id: p.id,
    model: p.modelName,
    x: p.x,
    y: p.y,
    hp: p.hp,
  }));

  return { grid, pieces, colourMap };
}

function actionsToSceneData(model: string, actions: PieceAction[]) {
  return {
    model,
    actions: actions.map(a => ({
      unit_id: a.unitId,
      action: a.action,
      direction: a.direction ?? undefined,
      target_id: a.targetId ?? undefined,
      target_x: a.targetX ?? undefined,
      target_y: a.targetY ?? undefined,
    })),
  };
}

// --- Props ---

interface Props {
  /** Current challenge state — emitted to the scene on every change. */
  state: ChallengeState | null;
  /** Model name → hex colour (0xRRGGBB) map for rendering. */
  colourMap: Record<string, number>;
  /** When set, the scene plays action animations for this model's turn. */
  lastActions?: { model: string; actions: PieceAction[] } | null;
  /** When set, the scene shows a winner overlay. */
  winner?: string | null;
}

export default function TerritoryWarCanvas({
  state, colourMap, lastActions, winner,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<Phaser.Game | null>(null);
  const prevStateRef = useRef<ChallengeState | null>(null);
  const prevActionsRef = useRef<{ model: string; actions: PieceAction[] } | null>(null);

  // Mount Phaser on first render, destroy on unmount
  useEffect(() => {
    if (!containerRef.current) return;

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: containerRef.current,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
      backgroundColor: '#0A0A0F',
      scene: [TerritoryWarScene],
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });

    gameRef.current = game;

    return () => {
      game.destroy(true);
      gameRef.current = null;
    };
  }, []);

  // Emit state updates to the Phaser scene
  useEffect(() => {
    if (!gameRef.current || !state) return;
    if (state === prevStateRef.current) return;
    prevStateRef.current = state;

    const data = stateToSceneData(state, colourMap);
    gameRef.current.events.emit(TW_STATE_UPDATE, data);
  }, [state, colourMap]);

  // Emit action animations
  useEffect(() => {
    if (!gameRef.current || !lastActions) return;
    if (lastActions === prevActionsRef.current) return;
    prevActionsRef.current = lastActions;

    const data = actionsToSceneData(lastActions.model, lastActions.actions);
    gameRef.current.events.emit(TW_ACTIONS, data);
  }, [lastActions]);

  // Emit game over
  useEffect(() => {
    if (!gameRef.current || !winner) return;
    gameRef.current.events.emit(TW_GAME_OVER, { winner });
  }, [winner]);

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        minHeight: 400,
        background: '#0A0A0F',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    />
  );
}
