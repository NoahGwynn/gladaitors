// ============================================================================
// GLADAITORS — Phaser Game Instance Config & Initialisation
// ============================================================================
// Creates and configures the Phaser game instance.
// Called from GameContainer.tsx inside a useEffect.
//
// IMPORTANT: Always call game.destroy(true) on cleanup to prevent
// duplicate instances on hot reload (see CLAUDE.md key rules).
//
// Usage:
//   const game = createGame(containerDiv, scene);
//   // on cleanup:
//   game.destroy(true);
// ============================================================================

import * as Phaser from 'phaser';

export function createGame(
  parent: HTMLDivElement,
  scene: typeof Phaser.Scene,
): Phaser.Game {
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#0A0A0F',  // --bg-void
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: 1344,   // 70% of 1920
      height: 952,   // 1080 - 48 (header) - 80 (event log)
    },
    scene,
    // Disable Phaser's default banner in console
    banner: false,
  };

  return new Phaser.Game(config);
}
