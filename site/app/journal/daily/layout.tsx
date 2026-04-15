import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "the dAIly — gladaitor",
  description:
    "Automated daily investigations by frontier AI models. Every morning, a neutral moderator picks a story, casts three models, and runs a structured session. Contradictions tracked over time.",
  openGraph: {
    title: "the dAIly — gladaitor",
    description:
      "Automated daily investigations by frontier AI models. Contradictions tracked over time.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "the dAIly — gladaitor",
    description:
      "Automated daily investigations by frontier AI models. Contradictions tracked over time.",
  },
};

export default function DailyLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
