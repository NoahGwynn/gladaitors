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

/** A complete stored debate */
export interface Debate {
  id: string;
  user_id: string;
  topic: string;
  positions: Record<string, string>;  // model_id → assigned position
  models: string[];                   // model_ids used
  rounds: number;
  context?: string;
  arguments: DebateArgument[];
  created_at: string;
  is_public: boolean;
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
