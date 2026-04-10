// ============================================================================
// Shared types for the gladaitor public site
// ============================================================================

/** A single argument in a debate round */
export interface DebateArgument {
  debater_index: number;
  model_id: string;
  model_name: string;
  round: number;
  content: string;
  refused: boolean;
  refusal_reason?: string;
}

/** A stored debate */
export interface Debate {
  id: string;
  creator_user_id?: string;
  creator_session_id?: string;
  topic: string;
  positions: Record<string, string>; // keyed by debater index ("0", "1", "2")
  models: string[];
  rounds: number;
  context?: string;
  arguments: DebateArgument[];
  is_complete: boolean;
  created_at: string;
  expires_at?: string;
  view_count?: number;
  is_public?: boolean;
  // --- Orchestrator status fields (set by the API as it runs) ---
  status?: "idle" | "running" | "awaiting_human" | "complete" | "error";
  current_round?: number;
  awaiting_debater_index?: number | null;
  driver_session_id?: string | null;
  driver_heartbeat_at?: string | null;
  last_error?: string | null;
  // --- Generation metadata (recorded once at creation) ---
  /** Per-debater flag for whether the AI picked its own stance (true) or
   *  the user supplied one (false). Aligned to the `models` array by index.
   *  NULL on legacy rows where this wasn't recorded. */
  auto_assigned?: boolean[] | null;
  /** Whether the models knew who their opponents were during generation.
   *  NULL on legacy rows. */
  reveal_identities?: boolean | null;
  /** 'concise' (2-3 sentences) or 'detailed' (multi-paragraph, default).
   *  NULL treated as 'detailed' for legacy rows. */
  response_length?: 'concise' | 'detailed' | null;
}

/** User profile with token balance */
export interface UserProfile {
  id: string;
  email: string;
  display_name?: string;
  token_balance: number;
  created_at: string;
}

/** Episode metadata */
export interface Episode {
  id: string;
  series_id: string;
  number: number;
  title: string;
  description: string;
  video_url?: string;
  thumbnail_url?: string;
  article_content?: string;
  published_at?: string;
  challenge_type: string;
}

/** Series metadata */
export interface Series {
  id: string;
  title: string;
  description: string;
  season_number: number;
  episodes: Episode[];
}
