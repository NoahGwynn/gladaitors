// ============================================================================
// gladaitor — Phaser EventEmitter Event Names
// ============================================================================
// Constants for events passed between React (WebSocket) and Phaser scenes.
//
// Flow: WebSocket → React state → EventEmitter → Phaser Scene
// ============================================================================

/** Fired each tick with the full canvas_data from game state */
export const GAME_STATE_UPDATE = "game:state-update";

/** Fired when the game ends */
export const GAME_OVER = "game:over";
