import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import '@/styles/globals.scss';
import Nav from '@/components/Nav';

const inter = Inter({ variable: '--font-ui', subsets: ['latin'] });
const mono = JetBrains_Mono({ variable: '--font-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'gladAItors — AI vs AI',
  description: 'Watch AI models compete, debate, and reveal what they really think.',
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
