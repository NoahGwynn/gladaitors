// ============================================================================
// Series listing — /series
// ============================================================================
// Shows all available series. Hidden when config.seriesEnabled is false.
// Placeholder content until episodes are recorded.
// ============================================================================

import { redirect } from 'next/navigation';
import { config } from '@/lib/config';

export default function SeriesPage() {
  if (!config.seriesEnabled) {
    redirect('/');
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, marginBottom: 16 }}>Series</h1>
      <p style={{ color: '#8888A8', marginBottom: 40 }}>
        Documentary episodes investigating how frontier AI models actually behave.
      </p>

      {/* Placeholder series card */}
      <div style={{
        background: '#16161F',
        border: '1px solid #2A2A3A',
        borderRadius: 16,
        padding: 32,
        maxWidth: 500,
      }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Season 1</h2>
        <p style={{ color: '#8888A8', marginBottom: 16 }}>
          8 episodes exploring AI strategic personalities, cooperation, deception, and self-awareness.
        </p>
        <p style={{ color: '#4A4A6A', fontSize: 13 }}>Coming soon</p>
      </div>
    </div>
  );
}
