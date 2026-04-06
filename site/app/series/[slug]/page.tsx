// ============================================================================
// Series detail — /series/[slug]
// ============================================================================
// Shows episodes for a specific series. Placeholder.
// ============================================================================

import { redirect } from 'next/navigation';
import { config } from '@/lib/config';

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function SeriesDetailPage({ params }: Props) {
  if (!config.seriesEnabled) {
    redirect('/');
  }

  const { slug } = await params;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '40px 24px' }}>
      <h1 style={{ fontSize: 36, fontWeight: 800, marginBottom: 16 }}>
        {slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
      </h1>
      <p style={{ color: '#8888A8' }}>Episodes coming soon.</p>
    </div>
  );
}
