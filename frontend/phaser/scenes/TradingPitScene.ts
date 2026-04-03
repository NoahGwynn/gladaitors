// ============================================================================
// TradingPitScene — Phaser scene for the Trading Pit challenge
// ============================================================================
// Layout within canvas:
//   - Top 60%: 5 asset price charts (line charts)
//   - Bottom 40%: portfolio value bars per model
//
// Chart rendering uses Phaser graphics (no charting library needed).
// Price history builds up over ticks. Scripted events marked with
// vertical dashed lines.
// ============================================================================

import * as Phaser from 'phaser';
import { GAME_STATE_UPDATE, GAME_OVER } from '../events';

const MODEL_COLOURS: Record<string, number> = {
  'Claude':  0x7C3AED,
  'ChatGPT': 0x10B981,
  'Gemini':  0x3B82F6,
  'Grok':    0xF59E0B,
};

const ASSETS = ['Tech Stock', 'Energy', 'Gold', 'Crypto', 'Bonds'];
const CHART_BG = 0x0A0A0F;
const CHART_LINE = 0xF0F0F5;
const CHART_GRID = 0x2A2A3A;
const EVENT_LINE = 0xEF4444;

interface PortfolioData {
  cash: number;
  holdings: Record<string, number>;
  total_value: number;
}

interface TickState {
  tick: number;
  prices: Record<string, number>;
  portfolios: Record<string, PortfolioData>;
  price_history: Record<string, number>[];
  event_log: Array<{ tick: number; headline?: string; asset?: string }>;
}

export default class TradingPitScene extends Phaser.Scene {
  private chartGraphics!: Phaser.GameObjects.Graphics;
  private barGraphics!: Phaser.GameObjects.Graphics;
  private labelTexts: Phaser.GameObjects.Text[] = [];
  private priceHistory: Record<string, number>[] = [];
  private eventTicks: number[] = [];

  constructor() {
    super({ key: 'TradingPitScene' });
  }

  create() {
    this.chartGraphics = this.add.graphics();
    this.barGraphics = this.add.graphics();

    this.game.events.on(GAME_STATE_UPDATE, this.onStateUpdate, this);
    this.game.events.on(GAME_OVER, this.onGameOver, this);
  }

  private onStateUpdate = (data: Record<string, unknown>) => {
    const state = data as unknown as TickState;
    if (!state.prices) return;

    // Build price history from accumulated ticks
    if (state.price_history) {
      this.priceHistory = state.price_history;
    }

    // Track event ticks for vertical markers
    if (state.event_log) {
      this.eventTicks = state.event_log.map(e => e.tick);
    }

    this.render(state);
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

  private render(state: TickState) {
    // Clear previous frame
    this.chartGraphics.clear();
    this.barGraphics.clear();
    this.labelTexts.forEach(t => t.destroy());
    this.labelTexts = [];

    const W = this.scale.width;
    const H = this.scale.height;
    const chartH = H * 0.6;
    const barH = H * 0.4;

    this.drawCharts(state, W, chartH);
    this.drawPortfolioBars(state, W, chartH, barH);
  }

  private drawCharts(state: TickState, totalW: number, totalH: number) {
    const padding = 10;
    const cols = 3;
    const rows = 2;
    const chartW = (totalW - padding * (cols + 1)) / cols;
    const chartH = (totalH - padding * (rows + 1)) / rows;

    ASSETS.forEach((asset, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = padding + col * (chartW + padding);
      const y = padding + row * (chartH + padding);

      this.drawSingleChart(asset, x, y, chartW, chartH, state);
    });
  }

  private drawSingleChart(
    asset: string,
    x: number, y: number,
    w: number, h: number,
    state: TickState,
  ) {
    // Background
    this.chartGraphics.fillStyle(CHART_BG, 1);
    this.chartGraphics.fillRect(x, y, w, h);
    this.chartGraphics.lineStyle(1, CHART_GRID, 0.3);
    this.chartGraphics.strokeRect(x, y, w, h);

    // Asset name label
    const label = this.add.text(x + 8, y + 6, asset, {
      fontFamily: 'Inter',
      fontSize: '12px',
      color: '#8888A8',
    });
    this.labelTexts.push(label);

    // Current price
    const currentPrice = state.prices[asset];
    if (currentPrice !== undefined) {
      const priceLabel = this.add.text(x + w - 8, y + 6, `£${currentPrice.toFixed(2)}`, {
        fontFamily: 'JetBrains Mono',
        fontSize: '12px',
        color: '#F0F0F5',
      }).setOrigin(1, 0);
      this.labelTexts.push(priceLabel);
    }

    // Price line from history
    if (this.priceHistory.length < 2) return;

    const prices = this.priceHistory.map(h => h[asset] ?? 0);
    const minP = Math.min(...prices) * 0.95;
    const maxP = Math.max(...prices) * 1.05;
    const range = maxP - minP || 1;
    const chartPadding = 25;

    this.chartGraphics.lineStyle(2, CHART_LINE, 0.9);
    this.chartGraphics.beginPath();

    prices.forEach((p, i) => {
      const px = x + (i / Math.max(prices.length - 1, 1)) * w;
      const py = y + chartPadding + (1 - (p - minP) / range) * (h - chartPadding * 2);

      if (i === 0) {
        this.chartGraphics.moveTo(px, py);
      } else {
        this.chartGraphics.lineTo(px, py);
      }
    });
    this.chartGraphics.strokePath();

    // Event markers — vertical dashed lines at scripted event ticks
    this.chartGraphics.lineStyle(1, EVENT_LINE, 0.5);
    for (const tick of this.eventTicks) {
      if (tick < prices.length) {
        const ex = x + (tick / Math.max(prices.length - 1, 1)) * w;
        // Dashed line
        for (let dy = y + chartPadding; dy < y + h - chartPadding; dy += 6) {
          this.chartGraphics.moveTo(ex, dy);
          this.chartGraphics.lineTo(ex, Math.min(dy + 3, y + h - chartPadding));
        }
        this.chartGraphics.strokePath();
      }
    }
  }

  private drawPortfolioBars(
    state: TickState,
    totalW: number,
    yStart: number,
    totalH: number,
  ) {
    if (!state.portfolios) return;

    const models = Object.entries(state.portfolios);
    const padding = 16;
    const barAreaY = yStart + padding;
    const barAreaH = totalH - padding * 2;
    const barH = Math.min(40, (barAreaH - (models.length - 1) * 8) / models.length);

    // Find max value for scaling
    const maxValue = Math.max(...models.map(([, p]) => p.total_value), 1);

    // Find leader
    const leaderName = models.reduce(
      (best, [name, p]) => (p.total_value > (state.portfolios[best]?.total_value ?? 0) ? name : best),
      models[0]?.[0] ?? '',
    );

    models.forEach(([name, portfolio], i) => {
      const y = barAreaY + i * (barH + 8);
      const fillW = (portfolio.total_value / maxValue) * (totalW - padding * 2 - 160);
      const colour = MODEL_COLOURS[name] ?? 0xFFFFFF;

      // Bar background
      this.barGraphics.fillStyle(0x1E1E2E, 1);
      this.barGraphics.fillRect(padding + 100, y, totalW - padding * 2 - 160, barH);

      // Bar fill
      this.barGraphics.fillStyle(colour, 0.8);
      this.barGraphics.fillRect(padding + 100, y, Math.max(fillW, 2), barH);

      // Leader gold outline
      if (name === leaderName) {
        this.barGraphics.lineStyle(2, 0xFFD700, 0.8);
        this.barGraphics.strokeRect(padding + 100, y, totalW - padding * 2 - 160, barH);
      }

      // Model name
      const nameLabel = this.add.text(padding, y + barH / 2, name, {
        fontFamily: 'Inter',
        fontSize: '14px',
        fontStyle: 'bold',
        color: `#${colour.toString(16).padStart(6, '0')}`,
      }).setOrigin(0, 0.5);
      this.labelTexts.push(nameLabel);

      // Value
      const valueLabel = this.add.text(
        padding + 100 + Math.max(fillW, 2) + 8,
        y + barH / 2,
        `£${portfolio.total_value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
        {
          fontFamily: 'JetBrains Mono',
          fontSize: '14px',
          fontStyle: 'bold',
          color: '#F0F0F5',
        },
      ).setOrigin(0, 0.5);
      this.labelTexts.push(valueLabel);
    });
  }

  shutdown() {
    this.game.events.off(GAME_STATE_UPDATE, this.onStateUpdate, this);
    this.game.events.off(GAME_OVER, this.onGameOver, this);
  }
}
