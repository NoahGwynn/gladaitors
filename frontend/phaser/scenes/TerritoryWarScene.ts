// ============================================================================
// TerritoryWarScene — Phaser scene for the Territory War challenge
// ============================================================================
// Renders a 20x20 grid with territory shading, pieces, bases, forts,
// and resources. Pieces are persistent game objects that animate between
// positions. Animations for move, attack, harvest, build, heal, death.
// ============================================================================

import * as Phaser from 'phaser';
import { GAME_STATE_UPDATE, GAME_OVER } from '../events';

const MODEL_COLOURS: Record<string, number> = {
  'Claude':  0x7C3AED,
  'ChatGPT': 0x10B981,
  'Gemini':  0x3B82F6,
  'Grok':    0xF59E0B,
};

let GRID_SIZE = 20; // Updated from game state on first tick
const TILE_UNCLAIMED = 0x1E1E2E;
const TILE_GRID_LINE = 0x2A2A3A;
const TILE_ORE = 0x8B6914;
const TILE_FOOD = 0x2D5A1B;
const ANIM_DURATION = 300;
const MAX_HP = 3;

const HP_COLOURS: Record<number, number> = {
  3: 0x22C55E,  // green — full
  2: 0xF59E0B,  // amber — wounded
  1: 0xEF4444,  // red — critical
};

interface TileData {
  x: number;
  y: number;
  type: string;
  owner?: string;
  resources?: number;
  fort_hp?: number;
}

interface PieceData {
  id: number;
  model: string;
  x: number;
  y: number;
  hp: number;
}

interface ActionTaken {
  unit_id: number;
  action: string;
  direction?: string;
  target_id?: number;
  target_x?: number;
  target_y?: number;
}

interface PieceSprite {
  container: Phaser.GameObjects.Container;
  circle: Phaser.GameObjects.Arc;
  hpBarBg: Phaser.GameObjects.Rectangle;
  hpBarFill: Phaser.GameObjects.Rectangle;
  lastX: number;
  lastY: number;
  lastHp: number;
  model: string;
}

export default class TerritoryWarScene extends Phaser.Scene {
  private tileSize = 0;
  private offsetX = 0;
  private offsetY = 0;
  private tileGraphics!: Phaser.GameObjects.Graphics;
  private labelTexts: Phaser.GameObjects.Text[] = [];
  private pieceSprites: Map<number, PieceSprite> = new Map();

  constructor() {
    super({ key: 'TerritoryWarScene' });
  }

  create() {
    const canvasW = this.scale.width;
    const canvasH = this.scale.height;
    this.tileSize = Math.floor(Math.min(canvasW / GRID_SIZE, canvasH / GRID_SIZE));
    this.offsetX = Math.floor((canvasW - this.tileSize * GRID_SIZE) / 2);
    this.offsetY = Math.floor((canvasH - this.tileSize * GRID_SIZE) / 2);

    this.tileGraphics = this.add.graphics();
    this.drawEmptyGrid();

    this.game.events.on(GAME_STATE_UPDATE, this.onStateUpdate, this);
    this.game.events.on(GAME_OVER, this.onGameOver, this);
  }

  private gridToPixel(gx: number, gy: number): { x: number; y: number } {
    return {
      x: this.offsetX + gx * this.tileSize + this.tileSize / 2,
      y: this.offsetY + gy * this.tileSize + this.tileSize / 2,
    };
  }

  private onStateUpdate = (data: Record<string, unknown>) => {
    const grid = data.grid as TileData[][];
    const pieces = data.units as PieceData[];
    const actionsTaken = data.actions_taken as { model: string; actions: ActionTaken[] } | undefined;

    // Detect grid size from data
    if (grid && grid.length > 0 && grid.length !== GRID_SIZE) {
      GRID_SIZE = grid.length;
      const canvasW = this.scale.width;
      const canvasH = this.scale.height;
      this.tileSize = Math.floor(Math.min(canvasW / GRID_SIZE, canvasH / GRID_SIZE));
      this.offsetX = Math.floor((canvasW - this.tileSize * GRID_SIZE) / 2);
      this.offsetY = Math.floor((canvasH - this.tileSize * GRID_SIZE) / 2);
    }

    if (grid) this.drawGrid(grid);
    if (pieces) this.updatePieces(pieces);
    if (actionsTaken) this.animateActions(actionsTaken);
  };

  private onGameOver = (data: Record<string, unknown>) => {
    const winner = data.winner as string;
    if (!winner) return;

    const colour = MODEL_COLOURS[winner] ?? 0xFFFFFF;
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0.6);
    overlay.fillRect(0, 0, this.scale.width, this.scale.height);

    this.add.text(cx, cy - 30, 'WINNER', {
      fontFamily: 'Inter', fontSize: '24px', color: '#FFD700', align: 'center',
    }).setOrigin(0.5);

    this.add.text(cx, cy + 20, winner, {
      fontFamily: 'Inter', fontSize: '48px', fontStyle: 'bold',
      color: `#${colour.toString(16).padStart(6, '0')}`, align: 'center',
    }).setOrigin(0.5);
  };

  // --- Action animations ---

  private animateActions(actionsTaken: { model: string; actions: ActionTaken[] }) {
    const modelColour = MODEL_COLOURS[actionsTaken.model] ?? 0xFFFFFF;

    for (const action of actionsTaken.actions) {
      const sprite = this.pieceSprites.get(action.unit_id);
      if (!sprite) continue;

      switch (action.action) {
        case 'harvest':
          this.animateHarvest(sprite, modelColour);
          break;
        case 'build':
          this.animateBuild(sprite);
          break;
        case 'attack':
          this.animateAttack(sprite, action, modelColour);
          break;
        case 'heal':
          this.animateHeal(sprite);
          break;
      }
    }
  }

  private animateHarvest(sprite: PieceSprite, colour: number) {
    // Pulsing ring effect around the piece — resource gathering
    const pos = { x: sprite.container.x, y: sprite.container.y };
    const ring = this.add.circle(pos.x, pos.y, this.tileSize * 0.35, colour, 0);
    ring.setStrokeStyle(2, 0xFFD700, 0.8);
    this.tweens.add({
      targets: ring,
      scale: 1.5,
      alpha: 0,
      duration: 500,
      onComplete: () => ring.destroy(),
    });

    // Small floating "+3" text
    const floatText = this.add.text(pos.x, pos.y - this.tileSize * 0.3, '+', {
      fontFamily: 'JetBrains Mono', fontSize: '10px', color: '#FFD700',
    }).setOrigin(0.5);
    this.tweens.add({
      targets: floatText,
      y: floatText.y - 15,
      alpha: 0,
      duration: 600,
      onComplete: () => floatText.destroy(),
    });
  }

  private animateBuild(sprite: PieceSprite) {
    // Construction effect — expanding square that fades
    const pos = { x: sprite.container.x, y: sprite.container.y };
    const square = this.add.rectangle(
      pos.x, pos.y, this.tileSize * 0.3, this.tileSize * 0.3, 0xFFD700, 0.6
    );
    this.tweens.add({
      targets: square,
      scaleX: 2.5,
      scaleY: 2.5,
      alpha: 0,
      duration: 600,
      ease: 'Power2',
      onComplete: () => square.destroy(),
    });

    // Floating fort icon
    const fortText = this.add.text(pos.x, pos.y, '\u{1F6E1}', {
      fontSize: `${Math.floor(this.tileSize * 0.5)}px`,
    }).setOrigin(0.5).setAlpha(0);
    this.tweens.add({
      targets: fortText,
      alpha: 1,
      scale: { from: 0.5, to: 1.2 },
      duration: 400,
      yoyo: true,
      onComplete: () => fortText.destroy(),
    });
  }

  private animateAttack(sprite: PieceSprite, action: ActionTaken, colour: number) {
    const attackerPos = { x: sprite.container.x, y: sprite.container.y };

    // Determine target position
    let targetPos: { x: number; y: number } | null = null;
    if (action.target_x !== undefined && action.target_y !== undefined) {
      targetPos = this.gridToPixel(action.target_x, action.target_y);
    } else if (action.target_id !== undefined) {
      const targetSprite = this.pieceSprites.get(action.target_id);
      if (targetSprite) {
        targetPos = { x: targetSprite.container.x, y: targetSprite.container.y };
      }
    }

    if (!targetPos) return;

    // Lunge animation — piece moves toward target then snaps back
    const dx = (targetPos.x - attackerPos.x) * 0.3;
    const dy = (targetPos.y - attackerPos.y) * 0.3;

    this.tweens.add({
      targets: sprite.container,
      x: attackerPos.x + dx,
      y: attackerPos.y + dy,
      duration: 100,
      yoyo: true,
      ease: 'Power2',
    });

    // Impact flash on the target
    const impact = this.add.circle(targetPos.x, targetPos.y, this.tileSize * 0.3, 0xEF4444, 0.6);
    this.tweens.add({
      targets: impact,
      scale: 1.8,
      alpha: 0,
      duration: 300,
      onComplete: () => impact.destroy(),
    });

    // Slash line from attacker toward target
    const slash = this.add.graphics();
    slash.lineStyle(3, colour, 0.8);
    slash.lineBetween(attackerPos.x, attackerPos.y, targetPos.x, targetPos.y);
    this.tweens.add({
      targets: slash,
      alpha: 0,
      duration: 400,
      onComplete: () => slash.destroy(),
    });
  }

  private animateHeal(sprite: PieceSprite) {
    const pos = { x: sprite.container.x, y: sprite.container.y };

    // Green cross effect
    const cross = this.add.text(pos.x, pos.y - this.tileSize * 0.3, '+', {
      fontFamily: 'Inter', fontSize: '14px', fontStyle: 'bold', color: '#22C55E',
    }).setOrigin(0.5);
    this.tweens.add({
      targets: cross,
      y: cross.y - 15,
      alpha: 0,
      duration: 600,
      onComplete: () => cross.destroy(),
    });

    // Green pulse ring
    const ring = this.add.circle(pos.x, pos.y, this.tileSize * 0.25, 0x22C55E, 0.3);
    this.tweens.add({
      targets: ring,
      scale: 1.8,
      alpha: 0,
      duration: 500,
      onComplete: () => ring.destroy(),
    });
  }

  // --- Grid and piece rendering ---

  private drawEmptyGrid() {
    this.tileGraphics.clear();
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        this.drawTile(x, y, TILE_UNCLAIMED);
      }
    }
  }

  private drawGrid(grid: TileData[][]) {
    this.tileGraphics.clear();
    this.labelTexts.forEach(t => t.destroy());
    this.labelTexts = [];

    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        const tile = grid[y][x];
        let colour = TILE_UNCLAIMED;
        let alpha = 1;

        if (tile.type === 'ore') {
          colour = TILE_ORE;
        } else if (tile.type === 'food') {
          colour = TILE_FOOD;
        } else if (tile.type === 'base' && tile.owner) {
          colour = MODEL_COLOURS[tile.owner] ?? TILE_UNCLAIMED;
          alpha = 0.8;
        } else if (tile.type === 'fort' && tile.owner) {
          colour = MODEL_COLOURS[tile.owner] ?? TILE_UNCLAIMED;
          alpha = 0.6;
        } else if (tile.owner) {
          colour = MODEL_COLOURS[tile.owner] ?? TILE_UNCLAIMED;
          alpha = 0.25;
        }

        this.drawTile(x, y, colour, alpha);

        const pos = this.gridToPixel(x, y);
        const iconSize = this.tileSize * 0.35;

        if (tile.type === 'base') {
          const label = this.add.text(pos.x, pos.y, '\u{1F3F0}', {
            fontSize: `${Math.floor(this.tileSize * 0.5)}px`,
          }).setOrigin(0.5);
          this.labelTexts.push(label);
        } else if (tile.type === 'fort') {
          const label = this.add.text(pos.x, pos.y, '\u{1F6E1}', {
            fontSize: `${Math.floor(this.tileSize * 0.4)}px`,
          }).setOrigin(0.5);
          this.labelTexts.push(label);
          if (tile.fort_hp !== undefined && tile.fort_hp < 5) {
            const hpLabel = this.add.text(pos.x, pos.y + iconSize, `${tile.fort_hp}`, {
              fontFamily: 'JetBrains Mono', fontSize: '9px', color: '#FF6666',
            }).setOrigin(0.5);
            this.labelTexts.push(hpLabel);
          }
        } else if (tile.type === 'ore') {
          const label = this.add.text(pos.x, pos.y, '\u{26CF}', {
            fontSize: `${Math.floor(iconSize)}px`,
          }).setOrigin(0.5);
          this.labelTexts.push(label);
        } else if (tile.type === 'food') {
          const label = this.add.text(pos.x, pos.y, '\u{1F33E}', {
            fontSize: `${Math.floor(iconSize)}px`,
          }).setOrigin(0.5);
          this.labelTexts.push(label);
        }
      }
    }
  }

  private drawTile(x: number, y: number, colour: number, alpha = 1) {
    const px = this.offsetX + x * this.tileSize;
    const py = this.offsetY + y * this.tileSize;

    this.tileGraphics.fillStyle(colour, alpha);
    this.tileGraphics.fillRect(px, py, this.tileSize, this.tileSize);
    this.tileGraphics.lineStyle(1, TILE_GRID_LINE, 0.5);
    this.tileGraphics.strokeRect(px, py, this.tileSize, this.tileSize);
  }

  private updatePieces(pieces: PieceData[]) {
    const radius = this.tileSize * 0.3;
    const barWidth = this.tileSize * 0.5;
    const barHeight = 3;
    const barY = -(radius + 6);
    const seenIds = new Set<number>();

    for (const piece of pieces) {
      seenIds.add(piece.id);
      const pos = this.gridToPixel(piece.x, piece.y);
      const fillColour = MODEL_COLOURS[piece.model] ?? 0xFFFFFF;
      const hpColour = HP_COLOURS[piece.hp] ?? 0xEF4444;

      let sprite = this.pieceSprites.get(piece.id);

      // If the model changed (e.g. after position rotation), destroy and recreate
      if (sprite && sprite.model !== piece.model) {
        sprite.container.destroy();
        this.pieceSprites.delete(piece.id);
        sprite = undefined;
      }

      if (!sprite) {
        const circle = this.add.circle(0, 0, radius, fillColour);
        circle.setStrokeStyle(2, 0xFFFFFF);

        const hpBarBg = this.add.rectangle(0, barY, barWidth, barHeight, 0x333333);
        hpBarBg.setOrigin(0.5);

        const hpBarFill = this.add.rectangle(0, barY, barWidth, barHeight, hpColour);
        hpBarFill.setOrigin(0.5);

        const container = this.add.container(pos.x, pos.y, [circle, hpBarBg, hpBarFill]);
        sprite = {
          container, circle, hpBarBg, hpBarFill,
          lastX: piece.x, lastY: piece.y, lastHp: piece.hp,
          model: piece.model,
        };
        this.pieceSprites.set(piece.id, sprite);
      }

      // Animate movement
      if (sprite.lastX !== piece.x || sprite.lastY !== piece.y) {
        this.tweens.add({
          targets: sprite.container,
          x: pos.x,
          y: pos.y,
          duration: ANIM_DURATION,
          ease: 'Power2',
        });
        this.flashTile(pos.x, pos.y, fillColour);
        sprite.lastX = piece.x;
        sprite.lastY = piece.y;
      }

      // Update health bar
      const hpFraction = piece.hp / MAX_HP;
      sprite.hpBarFill.setSize(barWidth * hpFraction, barHeight);
      sprite.hpBarFill.setFillStyle(hpColour);

      // HP change animations
      if (piece.hp < sprite.lastHp) {
        // Damage — red flash + shake
        this.tweens.add({
          targets: sprite.circle,
          fillColor: { from: 0xEF4444, to: fillColour },
          duration: 400,
        });
        this.tweens.add({
          targets: sprite.container,
          x: sprite.container.x + 3,
          duration: 50,
          yoyo: true,
          repeat: 2,
        });
      } else if (piece.hp > sprite.lastHp) {
        // Heal — green flash
        this.tweens.add({
          targets: sprite.circle,
          fillColor: { from: 0x22C55E, to: fillColour },
          duration: 400,
        });
      }

      sprite.lastHp = piece.hp;
    }

    // Remove destroyed pieces
    for (const [id, sprite] of this.pieceSprites) {
      if (!seenIds.has(id)) {
        this.tweens.add({
          targets: sprite.container,
          scaleX: 0,
          scaleY: 0,
          alpha: 0,
          duration: 400,
          ease: 'Power3',
          onComplete: () => sprite.container.destroy(),
        });
        this.pieceSprites.delete(id);
      }
    }
  }

  private flashTile(px: number, py: number, colour: number) {
    const flash = this.add.circle(px, py, this.tileSize * 0.4, colour, 0.4);
    this.tweens.add({
      targets: flash,
      alpha: 0,
      scale: 0.8,
      duration: 300,
      onComplete: () => flash.destroy(),
    });
  }

  shutdown() {
    this.game.events.off(GAME_STATE_UPDATE, this.onStateUpdate, this);
    this.game.events.off(GAME_OVER, this.onGameOver, this);
    for (const [, sprite] of this.pieceSprites) {
      sprite.container.destroy();
    }
    this.pieceSprites.clear();
  }
}
