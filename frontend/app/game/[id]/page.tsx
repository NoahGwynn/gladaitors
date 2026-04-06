// ============================================================================
// Game View — dynamic route at /game/[id]
// ============================================================================
// Supports /game/territory-war and /game/trading-pit.
// 'use client' with SSR disabled — localhost producer tool.
// ============================================================================

'use client';

import { useParams } from 'next/navigation';
import dynamic from 'next/dynamic';

const GameContainer = dynamic(
  () => import('@/components/GameContainer'),
  { ssr: false },
);

export default function GamePage() {
  const params = useParams();
  const id = params.id as string;

  const challengeType = id === 'trading-pit' ? 'trading_pit' as const : 'territory_war' as const;
  const episodeTitle = challengeType === 'territory_war'
    ? 'Episode 1 \u00B7 Territory War'
    : 'Episode 1 \u00B7 Trading Pit';

  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000/ws';

  return (
    <GameContainer
      challengeType={challengeType}
      episodeTitle={episodeTitle}
      wsUrl={wsUrl}
    />
  );
}
