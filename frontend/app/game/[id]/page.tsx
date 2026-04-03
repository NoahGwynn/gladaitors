// ============================================================================
// Game View — server component shell for /game/[id]
// ============================================================================
// Renders the GameContainer client component.
// The [id] param will eventually map to episode configs.
// For the pilot, all routes use the same default config.
// ============================================================================

import GameContainer from '@/components/GameContainer';

interface GamePageProps {
  params: Promise<{ id: string }>;
}

export default async function GamePage({ params }: GamePageProps) {
  const { id } = await params;

  // Default to territory_war for the pilot
  // Eventually this will look up episode config by ID
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
