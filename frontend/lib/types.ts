// ============================================================================
// GLADAITORS — Shared TypeScript Types
// ============================================================================
// All types used across React components, Phaser scenes, and WebSocket.
// Import from '@/lib/types' in any file.
// ============================================================================


// ----------------------------------------------------------------------------
// STATUS & IDENTITY
// ----------------------------------------------------------------------------

/** Model status shown on panels and badges */
export type BadgeStatus =
  | 'active'
  | 'thinking'
  | 'timeout'
  | 'rate_limited'
  | 'invalid'
  | 'winner'
  | 'eliminated';

/** Model identifier — matches backend MODEL_IDS values */
export type ModelId = 'claude' | 'gpt4o' | 'gemini' | 'grok';

/** Which challenge is currently running */
export type ChallengeType = 'territory_war' | 'trading_pit';


// ----------------------------------------------------------------------------
// GAME STATE — received from WebSocket each tick
// ----------------------------------------------------------------------------

/** Per-model state, rendered in ModelPanel components */
export interface ModelState {
  id: ModelId;
  name: string;
  colour: string;
  status: BadgeStatus;
  primary_metric: number;
  primary_metric_label: string;
  stats: Record<string, string | number>;
  last_action: string;
}

/** A single game event for the event log */
export interface GameEvent {
  tick: number;
  message: string;
}

/** Complete game state received from backend each tick */
export interface GameState {
  tick: number;
  max_ticks: number;
  elapsed_seconds: number;
  challenge: ChallengeType;
  models: ModelState[];
  events: GameEvent[];
  canvas_data: Record<string, unknown>;
}


// ----------------------------------------------------------------------------
// WEBSOCKET MESSAGES
// ----------------------------------------------------------------------------

export type WSMessageType = 'tick' | 'game_over';

export interface WSMessage {
  type: WSMessageType;
  tick?: number;
  state?: GameState;
}
