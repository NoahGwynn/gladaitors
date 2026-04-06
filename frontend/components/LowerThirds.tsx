// ============================================================================
// LowerThirds — transparent overlay for OBS Browser Source
// ============================================================================
// Rendered on /overlay as a second OBS layer on top of the game capture.
// Background is fully transparent — only the lower-third bars are visible.
//
// Shows:
//   - Model name bar (slides in when a model is acting)
//   - Bottom info strip (challenge name, turn counter, clock)
//
// Usage:
//   <LowerThirds gameState={gameState} />
// ============================================================================

'use client';

import type { GameState } from '@/lib/types';
import styles from './LowerThirds.module.scss';

interface LowerThirdsProps {
  gameState: GameState | null;
}

/** Format seconds into MM:SS */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

const CHALLENGE_LABELS: Record<string, string> = {
  territory_war: 'Territory War',
  trading_pit: 'Trading Pit',
};

export default function LowerThirds({ gameState }: LowerThirdsProps) {
  if (!gameState) return null;

  // Find the model currently "thinking" (if any) to show in the lower third
  const thinkingModel = gameState.models.find(m => m.status === 'thinking');
  const activeModel = thinkingModel ?? gameState.models.find(m => m.status === 'active');

  return (
    <div className={styles.overlay}>
      {/* Model name bar — slides in from left */}
      {activeModel && (
        <div className={`${styles.modelBar} ${styles[activeModel.id]}`}>
          <div className={styles.modelDot} />
          <span className={styles.modelName}>{activeModel.name}</span>
          <span className={styles.modelStatus}>
            {activeModel.last_action || activeModel.status}
          </span>
        </div>
      )}

      {/* Bottom info strip */}
      <div className={styles.infoBar}>
        <div className={styles.infoLeft}>
          <span className={styles.infoLabel}>
            {CHALLENGE_LABELS[gameState.challenge] ?? gameState.challenge}
          </span>
        </div>
        <div className={styles.infoRight}>
          <span className={styles.infoValue}>
            Turn {gameState.tick} / {gameState.max_ticks}
          </span>
          <span className={styles.infoValue}>
            {formatTime(gameState.elapsed_seconds)}
          </span>
        </div>
      </div>
    </div>
  );
}
