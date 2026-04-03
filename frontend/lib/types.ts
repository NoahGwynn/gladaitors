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

/** Model identifier — matches backend model names */
export type ModelId = 'claude' | 'gpt4o' | 'gemini' | 'grok';

/** Which challenge is currently running */
export type ChallengeType = 'territory_war' | 'trading_pit';


// ----------------------------------------------------------------------------
// GAME STATE — received from WebSocket each tick
// ----------------------------------------------------------------------------

/** Per-model state, rendered in ModelPanel components */
export interface ModelState {
  id: ModelId;
  name: string;                              // Display name (e.g. "Claude")
  colour: string;                            // Hex colour from config
  status: BadgeStatus;
  primary_metric: number;                    // Territory % or portfolio value
  primary_metric_label: string;              // "Territory" or "Portfolio"
  stats: Record<string, string | number>;    // Secondary stats (challenge-specific)
  last_action: string;                       // Human-readable last action
}

/** A single game event for the event log */
export interface GameEvent {
  tick: number;
  message: string;
  model_id?: ModelId;                        // Optional — for colour-coding
}

/** Complete game state received from backend each tick */
export interface GameState {
  tick: number;
  max_ticks: number;
  elapsed_seconds: number;
  challenge: ChallengeType;
  models: ModelState[];
  events: GameEvent[];
  canvas_data: Record<string, unknown>;      // Passed directly to Phaser scene
}


// ----------------------------------------------------------------------------
// WEBSOCKET MESSAGES
// ----------------------------------------------------------------------------

/** Message types sent by the backend */
export type WSMessageType = 'tick' | 'game_over';

/** WebSocket message envelope */
export interface WSMessage {
  type: WSMessageType;
  tick?: number;
  state?: GameState;
  results?: unknown[];
}
