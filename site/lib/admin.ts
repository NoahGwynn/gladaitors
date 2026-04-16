// ============================================================================
// Admin auth helpers
// ============================================================================
// The dAIly's operator-review tooling (approve/rerun on flagged turns)
// is gated by the `is_admin` flag on profiles. These helpers wrap the
// "is the current request from an admin?" check so route handlers and
// server components can stay terse.
//
// Granting admin access: there is intentionally no UI to flip this
// flag. An existing admin (or you, via Supabase SQL editor) sets
// `update profiles set is_admin = true where email = '...'`. This
// keeps the surface area for elevation small.
// ============================================================================

import { createServerSupabase } from './supabase-server';

export interface AdminUser {
  id: string;
  email: string | null;
}

/** Returns the current admin user if the caller is signed in AND has
 *  is_admin=true on their profile. Returns null otherwise. Never
 *  throws — let the caller decide between "401 not signed in",
 *  "403 not admin", or just "render the non-admin view". */
export async function getCurrentAdmin(): Promise<AdminUser | null> {
  const supabase = await createServerSupabase();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_admin, email')
    .eq('id', user.id)
    .single();

  if (!profile?.is_admin) return null;
  return { id: user.id, email: profile.email ?? user.email ?? null };
}

/** Returns just the boolean — useful in server components that only
 *  need to know whether to render admin chrome. */
export async function isCurrentUserAdmin(): Promise<boolean> {
  const admin = await getCurrentAdmin();
  return admin !== null;
}

/** API-route guard. Returns the admin user if authorised, otherwise
 *  returns a Response that the route handler should `return` directly.
 *  Pattern:
 *    const guard = await requireAdmin();
 *    if (guard instanceof Response) return guard;
 *    // ... use guard.id / guard.email
 */
export async function requireAdmin(): Promise<AdminUser | Response> {
  const admin = await getCurrentAdmin();
  if (admin) return admin;
  // Don't distinguish "not signed in" from "not admin" — both leak
  // the existence of admin gating to anonymous probers.
  return new Response(JSON.stringify({ error: 'Forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}
