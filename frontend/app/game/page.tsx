// ============================================================================
// Game View — default route at /game
// ============================================================================
// Defaults to Territory War. Use /game/trading-pit for Trading Pit.
// This is the main OBS Browser Source URL: http://localhost:3000/game
// ============================================================================

import GameContainer from '@/components/GameContainer';

export default function GamePage() {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000/ws';

  return (
    <GameContainer
      challengeType="territory_war"
      episodeTitle="Episode 1 &middot; Territory War"
      wsUrl={wsUrl}
    />
  );
}
