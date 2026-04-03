// ============================================================================
// Home — redirects to /game
// ============================================================================
// This is a localhost producer tool, not a public site.
// The root URL just redirects to the main game view.
// ============================================================================

import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/game');
}
