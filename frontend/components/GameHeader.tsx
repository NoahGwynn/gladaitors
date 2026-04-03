// ============================================================================
// GameHeader — top bar with branding, episode info, turn counter, and clock
// ============================================================================
// Fixed 48px height. Always visible during gameplay.
//
// Usage:
//   <GameHeader
//     episodeTitle="Episode 1 · Territory War"
//     tick={23}
//     maxTicks={60}
//     elapsedSeconds={462}
//   />
// ============================================================================

import styles from './GameHeader.module.scss';

interface GameHeaderProps {
  episodeTitle: string;
  tick: number;
  maxTicks: number;
  elapsedSeconds: number;
}

/** Format seconds into MM:SS */
function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, '0');
  const s = (seconds % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export default function GameHeader({
  episodeTitle,
  tick,
  maxTicks,
  elapsedSeconds,
}: GameHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.logo}>
        &#x2694;&#xFE0F; glad<span>AI</span>tors
      </div>

      <div className={styles.episodeTitle}>{episodeTitle}</div>

      <div className={styles.right}>
        <div className={styles.turnCounter}>
          Turn {tick} / {maxTicks}
        </div>
        <div className={styles.clock}>
          {formatTime(elapsedSeconds)}
        </div>
      </div>
    </header>
  );
}
