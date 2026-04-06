// ============================================================================
// useGameSocket — WebSocket hook for receiving live game state
// ============================================================================
// Connects to the backend WebSocket, parses incoming messages,
// and updates React state. Reconnects with exponential backoff.
// ============================================================================

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { GameState, WSMessage } from '@/lib/types';

const MAX_RECONNECT_DELAY = 10_000; // 10 seconds max

interface UseGameSocketReturn {
  gameState: GameState | null;
  connected: boolean;
}

export function useGameSocket(url: string): UseGameSocketReturn {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1000);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      reconnectDelayRef.current = 1000; // Reset backoff on successful connect
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      try {
        const message: WSMessage = JSON.parse(event.data);
        if ((message.type === 'tick' || message.type === 'game_over') && message.state) {
          setGameState(message.state);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      // Exponential backoff: 1s, 2s, 4s, 8s, 10s (capped)
      reconnectTimeoutRef.current = setTimeout(connect, reconnectDelayRef.current);
      reconnectDelayRef.current = Math.min(reconnectDelayRef.current * 2, MAX_RECONNECT_DELAY);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [connect]);

  return { gameState, connected };
}
