// ============================================================================
// Auth helpers — sign up, sign in, sign out, get user
// ============================================================================

import { createClient } from './supabase';
import { linkDebatesToUser } from './debates';

export async function signUp(email: string, password: string) {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signUp({ email, password });

  if (!error && data.user) {
    // Link any anonymous debates from this session to the new account
    await linkDebatesToUser();
  }

  return { data, error };
}

export async function signIn(email: string, password: string) {
  const supabase = createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (!error && data.user) {
    // Link any anonymous debates from this session
    await linkDebatesToUser();
  }

  return { data, error };
}

export async function signOut() {
  const supabase = createClient();
  return supabase.auth.signOut();
}

export async function getUser() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

export async function getProfile() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  return data;
}
