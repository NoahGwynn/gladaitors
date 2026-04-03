// ============================================================================
// useGameSocket — WebSocket hook for receiving live game state
// ============================================================================
// Connects to the backend WebSocket, parses incoming messages,
// and updates React state. Components read from the returned gameState.
// Phaser integration happens in GameContainer via EventEmitter.
//
// Usage:
//   const { gameState, connected } = useGameSocket('ws://localhost:8000/ws');
// ============================================================================

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { GameState, WSMessage } from '@/lib/types';

interface UseGameSocketReturn {
  gameState: GameState | null;
  connected: boolean;
}

export function useGameSocket(url: string): UseGameSocketReturn {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const connect = useCallback(() => {
    // Don't create duplicate connections
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const message: WSMessage = JSON.parse(event.data);

        if (message.type === 'tick' && message.state) {
          setGameState(message.state);
        } else if (message.type === 'game_over' && message.state) {
          setGameState(message.state);
        }
      } catch {
        // Silently ignore malformed messages
      }
    };

    ws.onclose = () => {
      setConnected(false);
      // Reconnect after 2 seconds
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [url]);

  useEffect(() => {
    connect();

    return () => {
      // Clean up on unmount
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { gameState, connected };
}
