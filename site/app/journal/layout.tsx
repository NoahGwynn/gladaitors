// ============================================================================
// Journal Lab layout — applies the light editorial theme
// ============================================================================
// Wraps every page under /journal/* in a `.theme-light` div. That class
// re-declares the colour CSS custom properties (defined in
// styles/globals.scss) so all descendant components flip from the dark
// site palette to the cream editorial one.
//
// Nav lives in the root layout above this wrapper, so it stays on the
// dark defaults — the visual handoff (dark Nav → light Journal) is
// the deliberate "you're entering the editorial side" moment.
//
// Subpage-specific layouts (e.g. /journal/debate/layout.tsx,
// /journal/daily/layout.tsx) are nested inside this one and inherit
// the theme automatically — they don't need to re-apply the class.
// ============================================================================

export default function JournalLabLayout({ children }: { children: React.ReactNode }) {
  return <div className="theme-light">{children}</div>;
}
