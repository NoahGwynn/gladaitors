// ============================================================================
// dAIly Forum — Source Registry
// ============================================================================
// Each source is pre-tagged with candidate categories. Items inherit
// these tags at ingestion time. Category organizers query by their tag
// to find candidates — e.g., the AI organizer sees everything tagged
// 'ai', the Science organizer sees everything tagged 'science'.
//
// No filtering at ingestion. Everything from every source is ingested.
// The organizers decide what's relevant to their category.
//
// This file defines the SEED data — the sources that get inserted into
// the forum_sources table on first run. After seeding, the database is
// the source of truth and this file is only used for reference.
// ============================================================================

export interface SourceDef {
  /** Candidate categories this source's items should be tagged with */
  categories: string[];
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
  // Anthropic does not publish an RSS feed. Their news reaches the
  // pipeline via HN, Reddit, ArXiv (papers), and newsletters.
  // {
  //   categories: ['ai'],
  //   sourceType: 'rss',
  //   name: 'Anthropic Blog',
  //   url: null,
  //   config: {},
  // },
  {
    categories: ['ai'],
    sourceType: 'rss',
    name: 'OpenAI Blog',
    url: 'https://openai.com/blog/rss.xml',
    config: {},
  },
  {
    categories: ['ai', 'science'],
    sourceType: 'rss',
    name: 'Google DeepMind Blog',
    url: 'https://deepmind.google/blog/rss.xml',
    config: {},
  },
  {
    categories: ['ai', 'tech'],
    sourceType: 'rss',
    name: 'Google AI Blog',
    url: 'https://blog.google/technology/ai/rss/',
    config: {},
  },
  // Meta AI does not publish an AI research RSS feed. Their AI news
  // reaches the pipeline via HN, Reddit, ArXiv (papers), and newsletters.
  // The investor relations press release feed below catches major
  // corporate announcements (Llama releases, data centre investments).
  {
    categories: ['tech'],
    sourceType: 'rss',
    name: 'Meta Press Releases',
    url: 'https://investor.atmeta.com/rss/pressrelease.aspx',
    config: {},
  },
  {
    categories: ['ai', 'tech'],
    sourceType: 'rss',
    name: 'Ars Technica AI',
    url: 'https://arstechnica.com/ai/feed/',
    config: {},
  },
  {
    categories: ['ai', 'tech'],
    sourceType: 'rss',
    name: 'The Verge AI',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    config: {},
  },
  {
    categories: ['ai', 'tech'],
    sourceType: 'rss',
    name: 'VentureBeat AI',
    url: 'https://venturebeat.com/category/ai/feed/',
    config: {},
  },
  {
    categories: ['ai', 'code'],
    sourceType: 'rss',
    name: 'Hugging Face Blog',
    url: 'https://huggingface.co/blog/feed.xml',
    config: {},
  },
  {
    categories: ['ai', 'tech', 'science'],
    sourceType: 'rss',
    name: 'MIT Technology Review AI',
    url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    config: {},
  },
  {
    categories: ['ai', 'tech'],
    sourceType: 'rss',
    name: 'Microsoft AI Blog',
    url: 'https://blogs.microsoft.com/ai/feed/',
    config: {},
  },
  {
    categories: ['ai', 'tech'],
    sourceType: 'rss',
    name: 'Nvidia AI Blog',
    url: 'https://blogs.nvidia.com/feed/',
    config: {},
  },
  {
    categories: ['ai', 'tech'],
    sourceType: 'rss',
    name: 'TechCrunch AI',
    url: 'https://techcrunch.com/category/artificial-intelligence/feed/',
    config: {},
  },
  {
    categories: ['ai', 'tech'],
    sourceType: 'rss',
    name: 'Wired AI',
    url: 'https://www.wired.com/feed/tag/ai/latest/rss',
    config: {},
  },
  {
    categories: ['ai'],
    sourceType: 'rss',
    name: 'The Decoder',
    url: 'https://the-decoder.com/feed/',
    config: {},
  },
  {
    categories: ['ai', 'tech', 'code'],
    sourceType: 'rss',
    name: 'AWS AI Blog',
    url: 'https://aws.amazon.com/blogs/machine-learning/feed/',
    config: {},
  },

  // --- APIs ---
  {
    categories: ['ai', 'science'],
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
    categories: ['ai', 'tech', 'code'],
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
    categories: ['ai', 'science'],
    sourceType: 'reddit',
    name: 'r/MachineLearning',
    url: 'https://www.reddit.com/r/MachineLearning/hot.json',
    config: { subreddit: 'MachineLearning', limit: 25 },
  },
  {
    categories: ['ai', 'code'],
    sourceType: 'reddit',
    name: 'r/LocalLLaMA',
    url: 'https://www.reddit.com/r/LocalLLaMA/hot.json',
    config: { subreddit: 'LocalLLaMA', limit: 25 },
  },
  {
    categories: ['ai'],
    sourceType: 'reddit',
    name: 'r/singularity',
    url: 'https://www.reddit.com/r/singularity/hot.json',
    config: { subreddit: 'singularity', limit: 15 },
  },
  {
    categories: ['ai'],
    sourceType: 'reddit',
    name: 'r/ClaudeAI',
    url: 'https://www.reddit.com/r/ClaudeAI/hot.json',
    config: { subreddit: 'ClaudeAI', limit: 15 },
  },
  {
    categories: ['ai'],
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
