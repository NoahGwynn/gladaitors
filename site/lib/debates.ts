// ============================================================================
// Debate storage — save, load, and share debates via Supabase
// ============================================================================

import { createClient } from './supabase';
import type { Debate, DebateArgument } from './types';

/** Generate or retrieve a session ID for anonymous debate ownership */
export function getSessionId(): string {
  if (typeof window === 'undefined') return '';
  let id = localStorage.getItem('gladaitors_session_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('gladaitors_session_id', id);
  }
  return id;
}

/** Create a new debate record (empty arguments, not complete yet) */
export async function createDebateRecord(params: {
  topic: string;
  positions: Record<string, string>;
  models: string[];
  rounds: number;
  context?: string;
}): Promise<string | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const sessionId = getSessionId();

  const { data, error } = await supabase
    .from('debates')
    .insert({
      creator_user_id: user?.id || null,
      creator_session_id: sessionId,
      topic: params.topic,
      positions: params.positions,
      models: params.models,
      rounds: params.rounds,
      context: params.context || null,
      arguments: [],
      is_complete: false,
      expires_at: user ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    console.error('Failed to create debate:', error);
    return null;
  }
  return data.id;
}

/** Update a debate's arguments (called as arguments stream in) */
export async function updateDebateArguments(
  id: string,
  args: DebateArgument[],
): Promise<void> {
  const supabase = createClient();
  await supabase
    .from('debates')
    .update({ arguments: args })
    .eq('id', id);
}

/** Mark a debate as complete (sets both legacy flag and orchestrator status) */
export async function completeDebate(id: string): Promise<void> {
  const supabase = createClient();
  await supabase
    .from('debates')
    .update({ is_complete: true, status: 'complete' })
    .eq('id', id);
}

/** Extend a completed debate: bump the rounds, append the args (which now
 *  may include a moderator note), and mark it incomplete so the orchestrator
 *  can resume. */
export async function extendDebate(
  id: string,
  newTotalRounds: number,
  args: DebateArgument[],
): Promise<void> {
  const supabase = createClient();
  await supabase
    .from('debates')
    .update({
      rounds: newTotalRounds,
      arguments: args,
      is_complete: false,
      status: 'idle',
    })
    .eq('id', id);
}

/** Save a completed debate in one step (legacy, used for non-streaming saves) */
export async function saveDebate(params: {
  topic: string;
  positions: Record<string, string>;
  models: string[];
  rounds: number;
  context?: string;
  arguments: DebateArgument[];
}): Promise<string | null> {
  const id = await createDebateRecord(params);
  if (!id) return null;
  await updateDebateArguments(id, params.arguments);
  await completeDebate(id);
  return id;
}

/** Load a debate by ID (and extend its TTL) */
export async function loadDebate(id: string): Promise<Debate | null> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from('debates')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) return null;

  // Extend TTL on view
  await supabase.rpc('extend_debate_ttl', { debate_id: id });

  return data as Debate;
}

/** Delete a debate by ID (owned by current user or current session) */
export async function deleteDebate(id: string): Promise<boolean> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const sessionId = getSessionId();

  // Try deleting by user ID first
  if (user) {
    const { error, count } = await supabase
      .from('debates')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('creator_user_id', user.id);

    if (!error && count && count > 0) return true;
  }

  // Fall back to deleting by session ID (for unlinked anonymous debates)
  if (sessionId) {
    const { error, count } = await supabase
      .from('debates')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('creator_session_id', sessionId);

    if (!error && count && count > 0) return true;
  }

  console.error('Debate not deleted — not owned by this user or session');
  return false;
}

/** Get debates for the current user (by user ID or session ID) */
export async function getUserDebates(): Promise<Debate[]> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  const sessionId = getSessionId();

  // Get debates owned by user ID or by session ID
  const filters = [];
  if (user) filters.push(`creator_user_id.eq.${user.id}`);
  if (sessionId) filters.push(`creator_session_id.eq.${sessionId}`);
  if (filters.length === 0) return [];

  const { data, error } = await supabase
    .from('debates')
    .select('*')
    .or(filters.join(','))
    .order('created_at', { ascending: false });

  if (error) return [];
  return (data || []) as Debate[];
}

/** Link anonymous debates to a newly signed-up user */
export async function linkDebatesToUser(): Promise<number> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;

  const sessionId = getSessionId();
  if (!sessionId) return 0;

  const { data, error } = await supabase
    .rpc('link_debates_to_user', {
      p_user_id: user.id,
      p_session_id: sessionId,
    });

  if (error) {
    console.error('Failed to link debates:', error);
    return 0;
  }

  return data as number;
}
