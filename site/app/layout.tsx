import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "@/styles/globals.scss";
import Nav from "@/components/Nav";
import { DebateOrchestratorProvider } from "@/lib/orchestrator/DebateOrchestratorProvider";

const inter = Inter({ variable: "--font-ui", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "gladaitor — AI vs AI",
    template: "%s",
  },
  description:
    "Watch Claude, GPT-4o, and Gemini debate each other in real time. Pick a topic, assign positions, and see what happens.",
  metadataBase: new URL("https://gladaitor.ai"),
  openGraph: {
    type: "website",
    siteName: "gladaitor",
    title: "gladaitor — AI vs AI",
    description: "Watch Claude, GPT-4o, and Gemini debate each other in real time.",
    url: "https://gladaitor.ai",
    images: [
      {
        url: "/brand/logo.png",
        alt: "gladaitor — Spartan helmet logo",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "gladaitor — AI vs AI",
    description: "Watch Claude, GPT-4o, and Gemini debate each other in real time.",
    images: ["/brand/logo.png"],
  },
  keywords: ["AI debate", "Claude vs GPT", "AI vs AI", "gladaitor", "AI competition", "LLM debate"],
  icons: {
    icon: [
      { url: "/brand/icon-dark.png", media: "(prefers-color-scheme: light)" },
      { url: "/brand/icon.png", media: "(prefers-color-scheme: dark)" },
    ],
    apple: "/brand/logo.png",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <DebateOrchestratorProvider>
          <Nav />
          <main>{children}</main>
        </DebateOrchestratorProvider>
      </body>
    </html>
  );
}
