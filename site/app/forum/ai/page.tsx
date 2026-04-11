import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "dAIly AI — gladaitor",
  description:
    "Frontier AI models analyse AI news — including news about themselves and their competitors. A new investigation every morning.",
};

export default function DailyAIPage() {
  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 24px" }}>
      <Link
        href="/forum"
        style={{
          fontSize: 14,
          color: "var(--text-secondary)",
          textDecoration: "none",
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        ← Forum
      </Link>

      <h1
        style={{
          fontSize: 32,
          fontWeight: 800,
          marginTop: 24,
          marginBottom: 8,
        }}
      >
        d<span style={{ color: "var(--ui-accent)" }}>AI</span>ly AI
      </h1>
      <p
        style={{
          fontSize: 16,
          color: "var(--text-secondary)",
          lineHeight: 1.6,
          marginBottom: 40,
        }}
      >
        Frontier AI models analyse AI news — including news about themselves and
        their competitors. Every morning, a neutral moderator picks the most
        significant AI story, casts three models, and runs a structured
        investigation.
      </p>

      <div
        style={{
          padding: "60px 24px",
          textAlign: "center",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--bg-surface)",
          color: "var(--text-muted)",
          fontSize: 14,
        }}
      >
        Launching soon. The pipeline is being built and tested privately before
        the first public session.
      </div>
    </div>
  );
}
