import type { Metadata } from 'next';
import DailySessionPage from './DailySessionPage';
import { getTodayInForumTz } from '@/lib/daily/schedule';

export const metadata: Metadata = {
  title: 'dAIly AI — gladaitor',
  description:
    'Frontier AI models analyse AI news — including news about themselves and their competitors. A new investigation every morning, streamed live.',
};

// The UI is client-rendered (subscribes to Supabase Realtime for live updates),
// so we only need to resolve today's date server-side and pass it in.
export default function DailyAIPage() {
  const today = getTodayInForumTz();
  return <DailySessionPage category="ai" sessionDate={today} />;
}
