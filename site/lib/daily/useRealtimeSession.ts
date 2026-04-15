// ============================================================================
// the dAIly — useRealtimeSession hook
// ============================================================================
// Client-side React hook that subscribes to a forum_sessions row for a
// given category + date via Supabase Realtime. Returns the live row
// state, which is the source of truth for the entire session page.
//
// As the pipeline progresses, stages write updates to the row
// (organize_snapshot → broadcast_snapshot → ... → debate_snapshot).
// Supabase Realtime pushes each update to this hook, which re-renders
// the page. The journey is then re-derived from the latest state via
// deriveSessionJourney.
//
// This is the single subscription point for the session page. All
// child components render from the row + derived journey.
//
// For the debate itself, incremental writes to debate_snapshot after
// each turn mean the debate appears turn-by-turn live as the pipeline
// runs — no separate streaming endpoint needed.
// ============================================================================

'use client';

import { useEffect, useState, useMemo } from 'react';
import { createClient } from '@/lib/supabase';
import {
  deriveSessionJourney,
  type SessionRowForJourney,
  type JourneyEvent,
} from './journey';

// --- Types ---

export interface UseRealtimeSessionResult {
  /** The live session row, or null if no session exists for this date/category */
  session: SessionRowForJourney | null;
  /** True on first load before the row has been fetched */
  loading: boolean;
  /** Fetch error message if the initial load failed */
  error: string | null;
  /** Derived journey — re-computed on every row update */
  journey: JourneyEvent[];
}

// --- Hook ---

/** Subscribe to a forum_sessions row by category + date.
 *
 *  On mount: fetches the row once, then subscribes to postgres_changes
 *  filtered by category + session_date. On every UPDATE/INSERT, re-fetches
 *  the full row (rather than merging the payload — simpler and avoids
 *  missing columns from partial updates).
 *
 *  Returns { session, loading, error, journey }. The journey is derived
 *  from the session row via the pure deriveSessionJourney function, so
 *  the page only needs to subscribe to one hook to get everything. */
export function useRealtimeSession(
  category: string,
  sessionDate: string,
): UseRealtimeSessionResult {
  const [session, setSession] = useState<SessionRowForJourney | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    async function fetchSession() {
      const { data, error: fetchError } = await supabase
        .from('forum_sessions')
        .select('*')
        .eq('category', category)
        .eq('session_date', sessionDate)
        .maybeSingle();

      if (cancelled) return;

      if (fetchError) {
        setError(fetchError.message);
        setLoading(false);
        return;
      }

      setSession((data as SessionRowForJourney) || null);
      setLoading(false);
    }

    fetchSession();

    // Subscribe to postgres_changes for this specific row
    const channel = supabase
      .channel(`forum-session-${category}-${sessionDate}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'forum_sessions',
          filter: `category=eq.${category}`,
        },
        async (payload) => {
          if (cancelled) return;
          // Only respond to rows matching our session_date — the filter
          // doesn't support compound filters, so we check client-side.
          const newRow = payload.new as { session_date?: string } | null;
          const oldRow = payload.old as { session_date?: string } | null;
          if (
            newRow?.session_date !== sessionDate &&
            oldRow?.session_date !== sessionDate
          ) {
            return;
          }
          // Re-fetch the full row for the latest state (handles INSERT,
          // UPDATE, DELETE uniformly)
          await fetchSession();
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [category, sessionDate]);

  // Derive the journey from the live session state. Recomputes on every
  // re-render, which is fine — deriveSessionJourney is a pure function
  // and the cost is negligible.
  const journey = useMemo(() => {
    if (!session) return [];
    return deriveSessionJourney(session);
  }, [session]);

  return { session, loading, error, journey };
}
