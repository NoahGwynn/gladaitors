// ============================================================================
// TerritoryWarScene — Phaser scene for Territory War
// ============================================================================
// Ported from frontend/phaser/scenes/TerritoryWarScene.ts (the producer
// tool). Adapted to receive data via the site's ChallengeState format.
//
// The scene renders a grid with territory shading, pieces with health
// bars, resource/fort icons, and per-action animations (attack lunge,
// harvest pulse, build expand, heal glow, death shrink).
//
// Data flows via Phaser game-level events:
//   TW_STATE_UPDATE — full grid + pieces (emitted on every state change)
//   TW_ACTIONS      — one model's actions for animation
//   TW_GAME_OVER    — winner name for overlay
// ============================================================================

import * as Phaser from 'phaser';
import { TW_STATE_UPDATE, TW_ACTIONS, TW_GAME_OVER } from './events';

// --- Colour map ---
// Maps model display names to hex colours. Falls back to white for
// unknown models. The React wrapper can also pass a colourMap via the
// state update event to override at runtime.
const DEFAULT_COLOURS: Record<string, number> = {
  'Claude Sonnet': 0xD97757,
  'Claude Opus':   0xD97757,
  'GPT-4o':        0x10A37F,
  'GPT-5':         0x10A37F,
  'Gemini Flash':  0x4285F4,
  'Gemini Pro':    0x4285F4,
};

let GRID_SIZE = 30;
const TILE_UNCLAIMED = 0x1E1E2E;
const TILE_GRID_LINE = 0x2A2A3A;
const TILE_ORE = 0x8B6914;
const TILE_FOOD = 0x2D5A1B;
const ANIM_DURATION = 300;
const MAX_HP = 3;

const HP_COLOURS: Record<number, number> = {
  3: 0x22C55E,
  2: 0xF59E0B,
  1: 0xEF4444,
};

// --- Data shapes (what the scene expects via events) ---

interface TileData {
  x: number;
  y: number;
  type: string;
  owner?: string | null;
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

interface ActionData {
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

// --- Static colour lookup ---
let runtimeColours: Record<string, number> = {};

function modelColour(name: string): number {
  return runtimeColours[name] ?? DEFAULT_COLOURS[name] ?? 0xFFFFFF;
}

// ============================================================================
// Scene
// ============================================================================

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
    this.recalcLayout();
    this.tileGraphics = this.add.graphics();
    this.drawEmptyGrid();

    this.game.events.on(TW_STATE_UPDATE, this.onStateUpdate, this);
    this.game.events.on(TW_ACTIONS, this.onActions, this);
    this.game.events.on(TW_GAME_OVER, this.onGameOver, this);
  }

  private recalcLayout() {
    const w = this.scale.width;
    const h = this.scale.height;
    this.tileSize = Math.floor(Math.min(w / GRID_SIZE, h / GRID_SIZE));
    this.offsetX = Math.floor((w - this.tileSize * GRID_SIZE) / 2);
    this.offsetY = Math.floor((h - this.tileSize * GRID_SIZE) / 2);
  }

  private gridToPixel(gx: number, gy: number) {
    return {
      x: this.offsetX + gx * this.tileSize + this.tileSize / 2,
      y: this.offsetY + gy * this.tileSize + this.tileSize / 2,
    };
  }

  // --- Event handlers ---

  private onStateUpdate = (data: {
    grid: TileData[][];
    pieces: PieceData[];
    colourMap?: Record<string, number>;
  }) => {
    if (data.colourMap) runtimeColours = data.colourMap;

    if (data.grid && data.grid.length > 0 && data.grid.length !== GRID_SIZE) {
      GRID_SIZE = data.grid.length;
      this.recalcLayout();
    }

    if (data.grid) this.drawGrid(data.grid);
    if (data.pieces) this.updatePieces(data.pieces);
  };

  private onActions = (data: { model: string; actions: ActionData[] }) => {
    this.animateActions(data);
  };

  private onGameOver = (data: { winner: string }) => {
    if (!data.winner) return;
    const colour = modelColour(data.winner);
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0.6);
    overlay.fillRect(0, 0, this.scale.width, this.scale.height);

    this.add.text(cx, cy - 30, 'WINNER', {
      fontFamily: 'Inter', fontSize: '24px', color: '#FFD700', align: 'center',
    }).setOrigin(0.5);

    this.add.text(cx, cy + 20, data.winner, {
      fontFamily: 'Inter', fontSize: '48px', fontStyle: 'bold',
      color: `#${colour.toString(16).padStart(6, '0')}`, align: 'center',
    }).setOrigin(0.5);
  };

  // --- Action animations ---

  private animateActions(data: { model: string; actions: ActionData[] }) {
    const colour = modelColour(data.model);
    for (const action of data.actions) {
      const sprite = this.pieceSprites.get(action.unit_id);
      if (!sprite) continue;
      switch (action.action) {
        case 'harvest': this.animateHarvest(sprite, colour); break;
        case 'build':   this.animateBuild(sprite); break;
        case 'attack':  this.animateAttack(sprite, action, colour); break;
        case 'heal':    this.animateHeal(sprite); break;
      }
    }
  }

  private animateHarvest(sprite: PieceSprite, colour: number) {
    const pos = { x: sprite.container.x, y: sprite.container.y };
    const ring = this.add.circle(pos.x, pos.y, this.tileSize * 0.35, colour, 0);
    ring.setStrokeStyle(2, 0xFFD700, 0.8);
    this.tweens.add({ targets: ring, scale: 1.5, alpha: 0, duration: 500, onComplete: () => ring.destroy() });
    const t = this.add.text(pos.x, pos.y - this.tileSize * 0.3, '+', { fontFamily: 'JetBrains Mono', fontSize: '10px', color: '#FFD700' }).setOrigin(0.5);
    this.tweens.add({ targets: t, y: t.y - 15, alpha: 0, duration: 600, onComplete: () => t.destroy() });
  }

  private animateBuild(sprite: PieceSprite) {
    const pos = { x: sprite.container.x, y: sprite.container.y };
    const sq = this.add.rectangle(pos.x, pos.y, this.tileSize * 0.3, this.tileSize * 0.3, 0xFFD700, 0.6);
    this.tweens.add({ targets: sq, scaleX: 2.5, scaleY: 2.5, alpha: 0, duration: 600, ease: 'Power2', onComplete: () => sq.destroy() });
    const ft = this.add.text(pos.x, pos.y, '\u{1F6E1}', { fontSize: `${Math.floor(this.tileSize * 0.5)}px` }).setOrigin(0.5).setAlpha(0);
    this.tweens.add({ targets: ft, alpha: 1, scale: { from: 0.5, to: 1.2 }, duration: 400, yoyo: true, onComplete: () => ft.destroy() });
  }

  private animateAttack(sprite: PieceSprite, action: ActionData, colour: number) {
    const ap = { x: sprite.container.x, y: sprite.container.y };
    let tp: { x: number; y: number } | null = null;
    if (action.target_x != null && action.target_y != null) {
      tp = this.gridToPixel(action.target_x, action.target_y);
    } else if (action.target_id != null) {
      const ts = this.pieceSprites.get(action.target_id);
      if (ts) tp = { x: ts.container.x, y: ts.container.y };
    }
    if (!tp) return;
    const dx = (tp.x - ap.x) * 0.3, dy = (tp.y - ap.y) * 0.3;
    this.tweens.add({ targets: sprite.container, x: ap.x + dx, y: ap.y + dy, duration: 100, yoyo: true, ease: 'Power2' });
    const impact = this.add.circle(tp.x, tp.y, this.tileSize * 0.3, 0xEF4444, 0.6);
    this.tweens.add({ targets: impact, scale: 1.8, alpha: 0, duration: 300, onComplete: () => impact.destroy() });
    const slash = this.add.graphics();
    slash.lineStyle(3, colour, 0.8);
    slash.lineBetween(ap.x, ap.y, tp.x, tp.y);
    this.tweens.add({ targets: slash, alpha: 0, duration: 400, onComplete: () => slash.destroy() });
  }

  private animateHeal(sprite: PieceSprite) {
    const pos = { x: sprite.container.x, y: sprite.container.y };
    const c = this.add.text(pos.x, pos.y - this.tileSize * 0.3, '+', { fontFamily: 'Inter', fontSize: '14px', fontStyle: 'bold', color: '#22C55E' }).setOrigin(0.5);
    this.tweens.add({ targets: c, y: c.y - 15, alpha: 0, duration: 600, onComplete: () => c.destroy() });
    const ring = this.add.circle(pos.x, pos.y, this.tileSize * 0.25, 0x22C55E, 0.3);
    this.tweens.add({ targets: ring, scale: 1.8, alpha: 0, duration: 500, onComplete: () => ring.destroy() });
  }

  // --- Grid rendering ---

  private drawEmptyGrid() {
    this.tileGraphics.clear();
    for (let y = 0; y < GRID_SIZE; y++)
      for (let x = 0; x < GRID_SIZE; x++)
        this.drawTile(x, y, TILE_UNCLAIMED);
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

        if (tile.type === 'ore') colour = TILE_ORE;
        else if (tile.type === 'food') colour = TILE_FOOD;
        else if (tile.type === 'base' && tile.owner) { colour = modelColour(tile.owner); alpha = 0.8; }
        else if (tile.type === 'fort' && tile.owner) { colour = modelColour(tile.owner); alpha = 0.6; }
        else if (tile.owner) { colour = modelColour(tile.owner); alpha = 0.25; }

        this.drawTile(x, y, colour, alpha);

        const pos = this.gridToPixel(x, y);
        const iconSize = this.tileSize * 0.35;

        if (tile.type === 'base') {
          this.labelTexts.push(this.add.text(pos.x, pos.y, '\u{1F3F0}', { fontSize: `${Math.floor(this.tileSize * 0.5)}px` }).setOrigin(0.5));
        } else if (tile.type === 'fort') {
          this.labelTexts.push(this.add.text(pos.x, pos.y, '\u{1F6E1}', { fontSize: `${Math.floor(this.tileSize * 0.4)}px` }).setOrigin(0.5));
          if (tile.fort_hp != null && tile.fort_hp < 5) {
            this.labelTexts.push(this.add.text(pos.x, pos.y + iconSize, `${tile.fort_hp}`, { fontFamily: 'JetBrains Mono', fontSize: '9px', color: '#FF6666' }).setOrigin(0.5));
          }
        } else if (tile.type === 'ore') {
          this.labelTexts.push(this.add.text(pos.x, pos.y, '\u{26CF}', { fontSize: `${Math.floor(iconSize)}px` }).setOrigin(0.5));
        } else if (tile.type === 'food') {
          this.labelTexts.push(this.add.text(pos.x, pos.y, '\u{1F33E}', { fontSize: `${Math.floor(iconSize)}px` }).setOrigin(0.5));
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

  // --- Piece rendering ---

  private updatePieces(pieces: PieceData[]) {
    const radius = this.tileSize * 0.3;
    const barWidth = this.tileSize * 0.5;
    const barHeight = 3;
    const barY = -(radius + 6);
    const seenIds = new Set<number>();

    for (const piece of pieces) {
      seenIds.add(piece.id);
      const pos = this.gridToPixel(piece.x, piece.y);
      const fillColour = modelColour(piece.model);
      const hpColour = HP_COLOURS[piece.hp] ?? 0xEF4444;

      let sprite = this.pieceSprites.get(piece.id);
      if (sprite && sprite.model !== piece.model) {
        sprite.container.destroy();
        this.pieceSprites.delete(piece.id);
        sprite = undefined;
      }

      if (!sprite) {
        const circle = this.add.circle(0, 0, radius, fillColour);
        circle.setStrokeStyle(2, 0xFFFFFF);
        const hpBarBg = this.add.rectangle(0, barY, barWidth, barHeight, 0x333333).setOrigin(0.5);
        const hpBarFill = this.add.rectangle(0, barY, barWidth, barHeight, hpColour).setOrigin(0.5);
        const container = this.add.container(pos.x, pos.y, [circle, hpBarBg, hpBarFill]);
        sprite = { container, circle, hpBarBg, hpBarFill, lastX: piece.x, lastY: piece.y, lastHp: piece.hp, model: piece.model };
        this.pieceSprites.set(piece.id, sprite);
      }

      if (sprite.lastX !== piece.x || sprite.lastY !== piece.y) {
        this.tweens.add({ targets: sprite.container, x: pos.x, y: pos.y, duration: ANIM_DURATION, ease: 'Power2' });
        this.flashTile(pos.x, pos.y, fillColour);
        sprite.lastX = piece.x;
        sprite.lastY = piece.y;
      }

      const hpFraction = piece.hp / MAX_HP;
      sprite.hpBarFill.setSize(barWidth * hpFraction, barHeight);
      sprite.hpBarFill.setFillStyle(hpColour);

      if (piece.hp < sprite.lastHp) {
        this.tweens.add({ targets: sprite.circle, fillColor: { from: 0xEF4444, to: fillColour }, duration: 400 });
        this.tweens.add({ targets: sprite.container, x: sprite.container.x + 3, duration: 50, yoyo: true, repeat: 2 });
      } else if (piece.hp > sprite.lastHp) {
        this.tweens.add({ targets: sprite.circle, fillColor: { from: 0x22C55E, to: fillColour }, duration: 400 });
      }
      sprite.lastHp = piece.hp;
    }

    for (const [id, sprite] of this.pieceSprites) {
      if (!seenIds.has(id)) {
        this.tweens.add({ targets: sprite.container, scaleX: 0, scaleY: 0, alpha: 0, duration: 400, ease: 'Power3', onComplete: () => sprite.container.destroy() });
        this.pieceSprites.delete(id);
      }
    }
  }

  private flashTile(px: number, py: number, colour: number) {
    const flash = this.add.circle(px, py, this.tileSize * 0.4, colour, 0.4);
    this.tweens.add({ targets: flash, alpha: 0, scale: 0.8, duration: 300, onComplete: () => flash.destroy() });
  }

  shutdown() {
    this.game.events.off(TW_STATE_UPDATE, this.onStateUpdate, this);
    this.game.events.off(TW_ACTIONS, this.onActions, this);
    this.game.events.off(TW_GAME_OVER, this.onGameOver, this);
    for (const [, sprite] of this.pieceSprites) sprite.container.destroy();
    this.pieceSprites.clear();
  }
}
