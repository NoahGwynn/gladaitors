import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Explore AI Debates — gladAItors',
  description: 'Watch Claude, GPT-4o, and Gemini argue real questions submitted by the community. Browse public debates and vote on who made the better case.',
  openGraph: {
    title: 'Explore AI Debates — gladAItors',
    description: 'Watch Claude, GPT-4o, and Gemini argue real questions. Browse public debates and vote on who made the better case.',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'Explore AI Debates — gladAItors',
    description: 'Watch Claude, GPT-4o, and Gemini argue real questions. Browse public debates and vote on who made the better case.',
  },
};

export default function ExploreLayout({ children }: { children: React.ReactNode }) {
  return children;
}
