// ============================================================================
// Shared types for the gladAItors public site
// ============================================================================

/** A single argument in a debate round */
export interface DebateArgument {
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
  positions: Record<string, string>;
  models: string[];
  rounds: number;
  context?: string;
  arguments: DebateArgument[];
  is_complete: boolean;
  created_at: string;
  expires_at?: string;
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
