// ============================================================================
// ResultsScene — dramatic winner reveal
// ============================================================================
// Fires when a game ends. This is the thumbnail moment for every episode.
// Full-screen takeover with model colour, winner name, and final stats.
//
// Designed for maximum visual impact in screenshots and thumbnails:
//   - Dark overlay fades in
//   - "WINNER" text appears with gold glow
//   - Model name in their identity colour, large and bold
//   - Final score/metric displayed below
//   - Subtle particle effect in model colour
// ============================================================================

import * as Phaser from 'phaser';
import { GAME_OVER } from '../events';

const MODEL_COLOURS: Record<string, number> = {
  'Claude':  0x7C3AED,
  'ChatGPT': 0x10B981,
  'Gemini':  0x3B82F6,
  'Grok':    0xF59E0B,
};

const GOLD = 0xFFD700;

interface ResultsData {
  winner: string;
  challenge: string;
  final_metric?: string;  // e.g. "£12,340" or "67% territory"
  models?: Array<{ name: string; metric: number }>;
}

export default class ResultsScene extends Phaser.Scene {
  constructor() {
    super({ key: 'ResultsScene' });
  }

  create() {
    this.game.events.on(GAME_OVER, this.onGameOver, this);
  }

  private onGameOver = (data: Record<string, unknown>) => {
    const results = data as unknown as ResultsData;
    if (!results.winner) return;

    this.showResults(results);
  };

  private showResults(results: ResultsData) {
    const W = this.scale.width;
    const H = this.scale.height;
    const cx = W / 2;
    const cy = H / 2;
    const modelColour = MODEL_COLOURS[results.winner] ?? 0xFFFFFF;
    const modelHex = `#${modelColour.toString(16).padStart(6, '0')}`;

    // --- Fade-in overlay ---
    const overlay = this.add.graphics();
    overlay.fillStyle(0x000000, 0);
    overlay.fillRect(0, 0, W, H);
    overlay.setAlpha(0);

    this.tweens.add({
      targets: overlay,
      alpha: 0.85,
      duration: 800,
      ease: 'Power2',
    });

    // --- Particle burst in model colour ---
    this.time.delayedCall(600, () => {
      this.addParticleBurst(cx, cy, modelColour);
    });

    // --- "WINNER" label ---
    const winnerLabel = this.add.text(cx, cy - 80, 'WINNER', {
      fontFamily: 'Inter',
      fontSize: '28px',
      fontStyle: 'bold',
      color: '#FFD700',
      align: 'center',
      letterSpacing: 8,
    }).setOrigin(0.5).setAlpha(0);

    this.tweens.add({
      targets: winnerLabel,
      alpha: 1,
      y: cy - 70,
      duration: 600,
      delay: 800,
      ease: 'Back.easeOut',
    });

    // --- Winner glow effect ---
    this.time.delayedCall(800, () => {
      this.tweens.add({
        targets: winnerLabel,
        // Pulsing scale for glow feel
        scaleX: { from: 1, to: 1.05 },
        scaleY: { from: 1, to: 1.05 },
        duration: 1200,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
    });

    // --- Model name (hero text) ---
    const nameText = this.add.text(cx, cy + 10, results.winner, {
      fontFamily: 'Inter',
      fontSize: '72px',
      fontStyle: 'bold',
      color: modelHex,
      align: 'center',
    }).setOrigin(0.5).setAlpha(0).setScale(0.5);

    this.tweens.add({
      targets: nameText,
      alpha: 1,
      scale: 1,
      duration: 700,
      delay: 1200,
      ease: 'Back.easeOut',
    });

    // --- Final metric ---
    if (results.final_metric) {
      const metricText = this.add.text(cx, cy + 80, results.final_metric, {
        fontFamily: 'JetBrains Mono',
        fontSize: '24px',
        color: '#F0F0F5',
        align: 'center',
      }).setOrigin(0.5).setAlpha(0);

      this.tweens.add({
        targets: metricText,
        alpha: 1,
        duration: 500,
        delay: 1800,
        ease: 'Power2',
      });
    }

    // --- Challenge name ---
    const challengeLabel = this.add.text(cx, cy + 130, results.challenge ?? '', {
      fontFamily: 'Inter',
      fontSize: '16px',
      color: '#8888A8',
      align: 'center',
    }).setOrigin(0.5).setAlpha(0);

    this.tweens.add({
      targets: challengeLabel,
      alpha: 1,
      duration: 500,
      delay: 2000,
      ease: 'Power2',
    });
  }

  private addParticleBurst(x: number, y: number, colour: number) {
    // Simple particle effect using graphics circles
    const count = 40;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.3;
      const speed = 150 + Math.random() * 200;
      const size = 3 + Math.random() * 4;

      const particle = this.add.graphics();
      particle.fillStyle(colour, 0.8);
      particle.fillCircle(0, 0, size);
      particle.setPosition(x, y);

      this.tweens.add({
        targets: particle,
        x: x + Math.cos(angle) * speed,
        y: y + Math.sin(angle) * speed,
        alpha: 0,
        scale: 0.3,
        duration: 1200 + Math.random() * 600,
        ease: 'Power3',
        onComplete: () => particle.destroy(),
      });
    }
  }

  shutdown() {
    this.game.events.off(GAME_OVER, this.onGameOver, this);
  }
}
