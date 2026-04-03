// ============================================================================
// TerritoryWarScene — Phaser scene for the Territory War challenge
// ============================================================================
// Renders a 20x20 grid with territory shading, units, bases, forts,
// and resources. Listens for state updates via the Phaser event registry.
//
// Tile colours:
//   - Unclaimed: #1E1E2E with grid lines #2A2A3A
//   - Claimed: model colour at 25% opacity
//   - Base: model colour at 80%, castle icon
//   - Fort: model colour at 60%, shield icon
//   - Ore: #8B6914
//   - Food: #2D5A1B
//
// Units: circular tokens, model colour fill, white border
// ============================================================================

import * as Phaser from 'phaser';
import { GAME_STATE_UPDATE, GAME_OVER } from '../events';

// Model colour lookup — matches CSS variables
const MODEL_COLOURS: Record<string, number> = {
  'Claude':  0x7C3AED,
  'ChatGPT': 0x10B981,
  'Gemini':  0x3B82F6,
  'Grok':    0xF59E0B,
};

const GRID_SIZE = 20;
const TILE_UNCLAIMED = 0x1E1E2E;
const TILE_GRID_LINE = 0x2A2A3A;
const TILE_ORE = 0x8B6914;
const TILE_FOOD = 0x2D5A1B;

interface TileData {
  x: number;
  y: number;
  type: string;
  owner?: string;
  resources?: number;
}

interface UnitData {
  id: number;
  model: string;
  x: number;
  y: number;
  hp: number;
  is_barbarian?: boolean;
}

export default class TerritoryWarScene extends Phaser.Scene {
  private tileSize = 0;
  private offsetX = 0;
  private offsetY = 0;
  private tileGraphics!: Phaser.GameObjects.Graphics;
  private unitGraphics!: Phaser.GameObjects.Graphics;
  private labelTexts: Phaser.GameObjects.Text[] = [];

  constructor() {
    super({ key: 'TerritoryWarScene' });
  }

  create() {
    // Calculate tile size to fit the canvas
    const canvasW = this.scale.width;
    const canvasH = this.scale.height;
    this.tileSize = Math.floor(Math.min(canvasW / GRID_SIZE, canvasH / GRID_SIZE));
    this.offsetX = Math.floor((canvasW - this.tileSize * GRID_SIZE) / 2);
    this.offsetY = Math.floor((canvasH - this.tileSize * GRID_SIZE) / 2);

    this.tileGraphics = this.add.graphics();
    this.unitGraphics = this.add.graphics();

    // Draw initial empty grid
    this.drawEmptyGrid();

    // Listen for state updates from React via EventEmitter
    this.game.events.on(GAME_STATE_UPDATE, this.onStateUpdate, this);
    this.game.events.on(GAME_OVER, this.onGameOver, this);
  }

  private onStateUpdate = (data: Record<string, unknown>) => {
    const grid = data.grid as TileData[][];
    const units = data.units as UnitData[];

    if (grid) this.drawGrid(grid);
    if (units) this.drawUnits(units);
  };

  private onGameOver = (data: Record<string, unknown>) => {
    const winner = data.winner as string;
    if (!winner) return;

    const colour = MODEL_COLOURS[winner] ?? 0xFFFFFF;
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;

    // Semi-transparent overlay
    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0.6);
    overlay.fillRect(0, 0, this.scale.width, this.scale.height);

    // Winner text
    this.add.text(cx, cy - 30, 'WINNER', {
      fontFamily: 'Inter',
      fontSize: '24px',
      color: '#FFD700',
      align: 'center',
    }).setOrigin(0.5);

    this.add.text(cx, cy + 20, winner, {
      fontFamily: 'Inter',
      fontSize: '48px',
      fontStyle: 'bold',
      color: `#${colour.toString(16).padStart(6, '0')}`,
      align: 'center',
    }).setOrigin(0.5);
  };

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

    // Clear old labels
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
          // Claimed empty tile — model colour at 25% opacity
          colour = MODEL_COLOURS[tile.owner] ?? TILE_UNCLAIMED;
          alpha = 0.25;
        }

        this.drawTile(x, y, colour, alpha);

        // Icons for special tiles
        const px = this.offsetX + x * this.tileSize + this.tileSize / 2;
        const py = this.offsetY + y * this.tileSize + this.tileSize / 2;

        if (tile.type === 'base') {
          const label = this.add.text(px, py, '\u{1F3F0}', {
            fontSize: `${Math.floor(this.tileSize * 0.5)}px`,
          }).setOrigin(0.5);
          this.labelTexts.push(label);
        } else if (tile.type === 'fort') {
          const label = this.add.text(px, py, '\u{1F6E1}', {
            fontSize: `${Math.floor(this.tileSize * 0.4)}px`,
          }).setOrigin(0.5);
          this.labelTexts.push(label);
        } else if (tile.type === 'ore') {
          const label = this.add.text(px, py, '\u{26CF}', {
            fontSize: `${Math.floor(this.tileSize * 0.35)}px`,
          }).setOrigin(0.5);
          this.labelTexts.push(label);
        } else if (tile.type === 'food') {
          const label = this.add.text(px, py, '\u{1F33E}', {
            fontSize: `${Math.floor(this.tileSize * 0.35)}px`,
          }).setOrigin(0.5);
          this.labelTexts.push(label);
        }
      }
    }
  }

  private drawTile(x: number, y: number, colour: number, alpha = 1) {
    const px = this.offsetX + x * this.tileSize;
    const py = this.offsetY + y * this.tileSize;

    // Fill
    this.tileGraphics.fillStyle(colour, alpha);
    this.tileGraphics.fillRect(px, py, this.tileSize, this.tileSize);

    // Grid line
    this.tileGraphics.lineStyle(1, TILE_GRID_LINE, 0.5);
    this.tileGraphics.strokeRect(px, py, this.tileSize, this.tileSize);
  }

  private drawUnits(units: UnitData[]) {
    this.unitGraphics.clear();
    const radius = this.tileSize * 0.3;

    for (const unit of units) {
      const cx = this.offsetX + unit.x * this.tileSize + this.tileSize / 2;
      const cy = this.offsetY + unit.y * this.tileSize + this.tileSize / 2;

      let fillColour: number;
      if (unit.is_barbarian) {
        fillColour = 0xEF4444; // Danger red for barbarians
      } else {
        fillColour = MODEL_COLOURS[unit.model] ?? 0xFFFFFF;
      }

      // White border
      this.unitGraphics.lineStyle(2, 0xFFFFFF, 1);
      this.unitGraphics.fillStyle(fillColour, 1);
      this.unitGraphics.fillCircle(cx, cy, radius);
      this.unitGraphics.strokeCircle(cx, cy, radius);

      // HP indicator — small dots below unit
      if (unit.hp < 3) {
        for (let i = 0; i < unit.hp; i++) {
          const dotX = cx - (unit.hp - 1) * 3 + i * 6;
          const dotY = cy + radius + 4;
          this.unitGraphics.fillStyle(0x22C55E, 1);
          this.unitGraphics.fillCircle(dotX, dotY, 2);
        }
      }
    }
  }

  shutdown() {
    this.game.events.off(GAME_STATE_UPDATE, this.onStateUpdate, this);
    this.game.events.off(GAME_OVER, this.onGameOver, this);
  }
}
