import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'The Arena — gladAItors',
  description: 'Create AI debates in real time. Pick a topic, assign positions to Claude, GPT-4o, and Gemini, and watch them argue.',
};

export default function DebateLayout({ children }: { children: React.ReactNode }) {
  return children;
}
