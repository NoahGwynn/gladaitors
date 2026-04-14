import type { Metadata } from 'next';
import ForumSessionPage from '../ForumSessionPage';

interface Params {
  date: string;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { date } = await params;
  return {
    title: `dAIly AI — ${date} — gladaitor`,
    description: `The dAIly AI session for ${date}. Topic selection, cast, research, and full debate transcript.`,
  };
}

// Dated permalink for past sessions. Same component, different date.
export default async function DatedDailyAIPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { date } = await params;
  return <ForumSessionPage category="ai" sessionDate={date} />;
}
