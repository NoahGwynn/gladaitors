// ============================================================================
// Game View — default route at /game
// ============================================================================
// Detects which game is loaded from the backend and renders the correct view.
// This is the main OBS Browser Source URL: http://localhost:3000/game
// ============================================================================

'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import type { ChallengeType } from '@/lib/types';

const GameContainer = dynamic(
  () => import('@/components/GameContainer'),
  { ssr: false },
);

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

const CHALLENGE_TITLES: Record<string, string> = {
  territory_war: 'Territory War',
  trading_pit: 'Trading Pit',
};

export default function GamePage() {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000/ws';
  const [challengeType, setChallengeType] = useState<ChallengeType>('territory_war');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Poll for game status until a game is loaded
    const check = async () => {
      try {
        const res = await fetch(`${API_BASE}/games/status`);
        const data = await res.json();
        if (data.game) {
          setChallengeType(data.game as ChallengeType);
        }
      } catch {
        // Backend not ready yet
      }
      setReady(true);
    };
    check();

    // Re-check periodically in case game changes
    const interval = setInterval(check, 3000);
    return () => clearInterval(interval);
  }, []);

  if (!ready) return null;

  const title = CHALLENGE_TITLES[challengeType] || challengeType;

  return (
    <GameContainer
      challengeType={challengeType}
      episodeTitle={title}
      wsUrl={wsUrl}
    />
  );
}
