// ============================================================================
// Episode page — /series/[slug]/[episode]
// ============================================================================
// Full-width video banner + article below. Placeholder.
// ============================================================================

import { redirect } from 'next/navigation';
import { config } from '@/lib/config';

interface Props {
  params: Promise<{ slug: string; episode: string }>;
}

export default async function EpisodePage({ params }: Props) {
  if (!config.seriesEnabled) {
    redirect('/');
  }

  const { slug, episode } = await params;

  return (
    <div>
      {/* Video banner placeholder */}
      <div style={{
        width: '100%',
        height: '60vh',
        background: 'linear-gradient(180deg, #1A1A26 0%, #0A0A0F 100%)',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        padding: '40px 24px',
      }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
          <p style={{ color: '#8888A8', fontSize: 13, marginBottom: 8 }}>
            {slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
          </p>
          <h1 style={{ fontSize: 48, fontWeight: 800, marginBottom: 12 }}>
            Episode {episode}
          </h1>
          <p style={{ color: '#8888A8', fontSize: 17, maxWidth: 600 }}>
            Episode description placeholder. The full episode will appear here
            when published, with a video player and episode controls.
          </p>
        </div>
      </div>

      {/* Article section */}
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '64px 24px' }}>
        <h2 style={{ fontSize: 28, fontWeight: 700, marginBottom: 24 }}>
          Behind the Episode
        </h2>
        <p style={{ color: '#8888A8', lineHeight: 1.8 }}>
          This section will contain the making-of article for this episode,
          including experiment methodology, findings, data visualisations,
          and conclusions. Written after the episode is recorded and edited.
        </p>
      </div>
    </div>
  );
}
