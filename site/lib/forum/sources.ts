// ============================================================================
// dAIly Forum — Source Registry
// ============================================================================
// The list of configured data sources for each category. Each source
// has a type (rss, api, newsletter), a name, a URL, and optional config.
//
// This file defines the SEED data — the sources that get inserted into
// the forum_sources table on first run. After seeding, the database is
// the source of truth and this file is only used for reference.
// ============================================================================

export interface SourceDef {
  category: string;
  sourceType: 'rss' | 'api' | 'newsletter' | 'reddit';
  name: string;
  url: string | null;
  config: Record<string, unknown>;
}

// ============================================================================
// dAIly AI — Tier 1, first to launch
// ============================================================================

export const DAILY_AI_SOURCES: SourceDef[] = [
  // --- RSS feeds ---
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'Anthropic Blog',
    url: 'https://www.anthropic.com/rss',
    config: {},
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'OpenAI Blog',
    url: 'https://openai.com/blog/rss.xml',
    config: {},
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'Google DeepMind Blog',
    url: 'https://deepmind.google/blog/rss.xml',
    config: {},
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'Google AI Blog',
    url: 'https://blog.google/technology/ai/rss/',
    config: {},
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'Meta AI Blog',
    url: 'https://ai.meta.com/blog/rss/',
    config: {},
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'Ars Technica AI',
    url: 'https://feeds.arstechnica.com/arstechnica/features',
    config: { filterKeywords: ['AI', 'artificial intelligence', 'machine learning', 'LLM', 'GPT', 'Claude', 'Gemini'] },
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'The Verge AI',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    config: {},
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'VentureBeat AI',
    url: 'https://venturebeat.com/category/ai/feed/',
    config: {},
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'Hugging Face Blog',
    url: 'https://huggingface.co/blog/feed.xml',
    config: {},
  },
  {
    category: 'ai',
    sourceType: 'rss',
    name: 'MIT Technology Review AI',
    url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    config: {},
  },

  // --- APIs ---
  {
    category: 'ai',
    sourceType: 'api',
    name: 'ArXiv AI',
    url: 'https://export.arxiv.org/api/query',
    config: {
      categories: ['cs.AI', 'cs.CL', 'cs.LG'],
      maxResults: 50,
      sortBy: 'submittedDate',
      sortOrder: 'descending',
    },
  },
  {
    category: 'ai',
    sourceType: 'api',
    name: 'Hacker News',
    url: 'https://hacker-news.firebaseio.com/v0',
    config: {
      filterKeywords: ['AI', 'LLM', 'GPT', 'Claude', 'Gemini', 'Anthropic', 'OpenAI', 'DeepMind', 'machine learning', 'neural', 'transformer'],
      maxItems: 30,
    },
  },

  // --- Reddit ---
  {
    category: 'ai',
    sourceType: 'reddit',
    name: 'r/MachineLearning',
    url: 'https://www.reddit.com/r/MachineLearning/hot.json',
    config: { subreddit: 'MachineLearning', limit: 25 },
  },
  {
    category: 'ai',
    sourceType: 'reddit',
    name: 'r/LocalLLaMA',
    url: 'https://www.reddit.com/r/LocalLLaMA/hot.json',
    config: { subreddit: 'LocalLLaMA', limit: 25 },
  },
  {
    category: 'ai',
    sourceType: 'reddit',
    name: 'r/singularity',
    url: 'https://www.reddit.com/r/singularity/hot.json',
    config: { subreddit: 'singularity', limit: 15 },
  },
  {
    category: 'ai',
    sourceType: 'reddit',
    name: 'r/ClaudeAI',
    url: 'https://www.reddit.com/r/ClaudeAI/hot.json',
    config: { subreddit: 'ClaudeAI', limit: 15 },
  },
  {
    category: 'ai',
    sourceType: 'reddit',
    name: 'r/ChatGPT',
    url: 'https://www.reddit.com/r/ChatGPT/hot.json',
    config: { subreddit: 'ChatGPT', limit: 15 },
  },
];

// ============================================================================
// All sources (expand as categories are added)
// ============================================================================

export const ALL_SOURCES: SourceDef[] = [
  ...DAILY_AI_SOURCES,
];
