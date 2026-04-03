// ============================================================================
// GLADAITORS — Phaser EventEmitter Event Names
// ============================================================================
// Constants for events passed between React (WebSocket) and Phaser scenes.
// Using constants prevents typo bugs and makes events discoverable.
//
// Flow: WebSocket → React state → EventEmitter → Phaser Scene
// ============================================================================

/** Fired each tick with the full canvas_data from game state */
export const GAME_STATE_UPDATE = 'game:state-update';

/** Fired when a scripted event occurs (banner-worthy moment) */
export const GAME_EVENT = 'game:event';

/** Fired when the game ends */
export const GAME_OVER = 'game:over';
