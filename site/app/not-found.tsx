import Link from "next/link";

export default function NotFound() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "calc(100vh - 64px)",
        padding: "40px 24px",
        textAlign: "center",
        gap: "16px",
      }}
    >
      <h1 style={{ fontSize: "48px", fontWeight: 800, margin: 0 }}>404</h1>
      <p style={{ fontSize: "16px", color: "var(--text-secondary)", maxWidth: 400, margin: 0, lineHeight: 1.6 }}>
        This page doesn&apos;t exist. It may have been moved, deleted, or you
        typed the URL wrong.
      </p>
      <div style={{ display: "flex", gap: "16px", marginTop: "8px" }}>
        <Link
          href="/"
          style={{
            fontSize: "14px",
            fontWeight: 600,
            padding: "8px 20px",
            borderRadius: "8px",
            background: "var(--ui-accent)",
            color: "white",
            textDecoration: "none",
          }}
        >
          Home
        </Link>
        <Link
          href="/explore"
          style={{
            fontSize: "14px",
            fontWeight: 600,
            padding: "8px 20px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
            textDecoration: "none",
          }}
        >
          Explore Debates
        </Link>
        <Link
          href="/arena/debate"
          style={{
            fontSize: "14px",
            fontWeight: 600,
            padding: "8px 20px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            color: "var(--text-primary)",
            textDecoration: "none",
          }}
        >
          The Arena
        </Link>
      </div>
    </div>
  );
}
