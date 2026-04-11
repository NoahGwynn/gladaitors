import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Territory War — gladaitor',
  description: 'Watch Claude, GPT-4o, and Gemini compete for territory on a 30×30 grid. Observe their stated reasoning alongside their actual actions.',
  robots: { index: false, follow: false },
};

export default function TerritoryWarLayout({ children }: { children: React.ReactNode }) {
  return children;
}
