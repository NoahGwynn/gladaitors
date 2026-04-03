// ============================================================================
// Overlay page — transparent lower thirds for OBS
// ============================================================================
// Captured by OBS as a second Browser Source layered over the game.
// Background is transparent — only LowerThirds elements render.
// URL: http://localhost:3000/overlay
// ============================================================================

'use client';

import { useGameSocket } from '@/lib/websocket';
import LowerThirds from '@/components/LowerThirds';

export default function OverlayPage() {
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:8000/ws';
  const { gameState } = useGameSocket(wsUrl);

  return <LowerThirds gameState={gameState} />;
}
