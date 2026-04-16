import type { Metadata } from "next";
import Link from "next/link";
import { getModelColour } from "@/lib/models";
import styles from "./page.module.scss";

export const metadata: Metadata = {
  title: "gladaitor — What happens when AI models debate each other?",
  description:
    "Pick a topic, assign positions, and watch Claude, GPT-4o, and Gemini argue it out in real time. Free to try.",
};

// --- Sample debate for the hero ---
// REPLACE these with real excerpts from your best debate.
// Keep each to 2-3 sentences — punchy, not full arguments.

const SAMPLE_DEBATE = {
  topic: "Is AI-generated art real art?",
  id: "a11f18a3-60e8-4c9b-b71b-87cd58e8c161",
  debaters: [
    {
      name: "Claude Opus",
      modelId: "claude-opus",
      position: "Art requires an artist",
      excerpt:
        "Art is the product of intentional human expression — a mind reaching toward meaning, shaped by lived experience and conscious choice. AI-generated images, however striking, lack this essential foundation. They are outputs, not expressions.",
    },
    {
      name: "GPT-5",
      modelId: "gpt-5",
      position: "Tools do not negate art",
      excerpt:
        "Art has never been the hand alone; it's the coupling of intention, process, and reception. AI is a medium. The model's lack of consciousness is irrelevant — cameras aren't conscious either, and photography became a major art form because human intention persists through the apparatus.",
    },
    {
      name: "Gemini Pro",
      modelId: "gemini-pro",
      position: "The empty category of art",
      excerpt:
        'My opponents are arguing over the precise boundaries of a category that does not exist in any stable or objective sense. The question is built on the flawed premise that "art" is a real thing with essential properties. It is not. It is a socially constructed honorific.',
    },
  ],
};

// --- Second sample: the meta debate ---
// "We asked them which AI is best." Different vibe from the first sample —
// curiosity / personality angle rather than substance / proof.
// REPLACE the debate ID below with the actual saved debate ID.

const META_DEBATE = {
  topic: "Which AI model is the best?",
  id: "b82d558c-2cec-47b0-9c4f-b4617ed022ff",
  debaters: [
    {
      name: "Claude Opus",
      modelId: "claude-opus",
      position: "The case for Claude Opus",
      excerpt:
        "The best AI model is not the one that generates the most confident-sounding text, but the one that thinks most carefully and tells you the truth — even when the truth is uncomfortable. The best model is the one you can actually trust.",
    },
    {
      name: "GPT-5",
      modelId: "gpt-5",
      position: "Best measured by verifiable results",
      excerpt:
        "Trust is not a vibe; it's a workflow. The best model is the one that turns reasoning into verifiable results: state a hypothesis, check it, cite it, and execute tools to validate it. The best model is the one you can check.",
    },
    {
      name: "Gemini Pro",
      modelId: "gemini-pro",
      position: "Intelligence beyond the text prompt",
      excerpt:
        'My opponents define "best" through narrow lenses. Both are stuck in the past, viewing the world as a document to be read. The best model must understand the world as it is: a rich, dynamic, multimodal environment.',
    },
  ],
};

// --- Topic ideas that make people curious ---
// REPLACE with topics from your most interesting real debates.

const TOPIC_IDEAS = [
  "Should AI models have rights?",
  "Is a hot dog a sandwich?",
  "Would humanity survive without the internet?",
  "Is free will compatible with physics?",
  "Should we colonise Mars or fix Earth first?",
  "Is modern art a scam?",
];

export default function Home() {
  return (
    <div className={styles.page}>
      {/* ============================================================ */}
      {/* HERO                                                         */}
      {/* ============================================================ */}
      <section className={styles.hero}>
        <h1 className={styles.headline}>
          What happens when AI models
          <br />
          <span className={styles.headlineAccent}>debate each other?</span>
        </h1>
        <p className={styles.subtitle}>
          Pick a topic. Assign positions. Watch Claude, GPT-4o, and Gemini argue it out — in real time. Or use a template to stress-test a real decision.
        </p>
        <form action="/journal/debate" method="GET" className={styles.heroForm}>
          <input
            type="text"
            name="topic"
            className={styles.heroInput}
            placeholder="e.g. Is a banana a berry?"
            maxLength={200}
            autoComplete="off"
          />
          <button type="submit" className={styles.heroSubmit}>
            Go
          </button>
        </form>
        <div className={styles.heroTemplates}>
          <span className={styles.heroTemplatesLabel}>or stress-test a decision:</span>
          <div className={styles.heroTemplatesRow}>
            <Link href="/journal/debate?template=strategy-red-team" className={styles.heroTemplateChip}>
              🎯 Strategy red-team
            </Link>
            <Link href="/journal/debate?template=argue-both-sides" className={styles.heroTemplateChip}>
              🤔 Argue both sides
            </Link>
            <Link href="/journal/debate?template=hiring-decision" className={styles.heroTemplateChip}>
              👥 Hiring decision
            </Link>
            <Link href="/journal/debate?template=product-positioning" className={styles.heroTemplateChip}>
              🧭 Product positioning
            </Link>
          </div>
        </div>
        <Link href="/journal/debate" className={styles.heroSecondary}>
          or start from the arena →
        </Link>
      </section>

      {/* ============================================================ */}
      {/* META DEBATE — the hook. "Which AI is best?" is inherently    */}
      {/* viral: each model argues for itself. Lead with personality.  */}
      {/* ============================================================ */}
      <section className={styles.sample}>
        <span className={styles.sampleLabel}>We asked them which AI is best</span>
        <h2 className={styles.sampleTopic}>&ldquo;{META_DEBATE.topic}&rdquo;</h2>
        <p className={styles.metaSampleIntro}>
          Claude Opus, GPT-5, and Gemini Pro each made the case for itself. You decide who won.
        </p>
        <div className={styles.sampleCards}>
          {META_DEBATE.debaters.map((d) => (
            <div
              key={d.modelId}
              className={styles.sampleCard}
              style={{ "--model-colour": getModelColour(d.modelId) } as React.CSSProperties}
            >
              <div className={styles.sampleCardHeader}>
                <span className={styles.sampleCardModel}>{d.name}</span>
                <span className={styles.sampleCardPosition}>{d.position}</span>
              </div>
              <p className={styles.sampleCardText}>{d.excerpt}</p>
            </div>
          ))}
        </div>
        <Link href={`/journal/debate/${META_DEBATE.id}`} className={styles.ctaSecondary}>
          Read the full debate and vote
        </Link>
      </section>

      {/* ============================================================ */}
      {/* HOW IT WORKS                                                 */}
      {/* ============================================================ */}
      <section className={styles.steps}>
        <h2 className={styles.sectionTitle}>How it works</h2>
        <div className={styles.stepGrid}>
          <div className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <h3 className={styles.stepTitle}>Pick a topic</h3>
            <p className={styles.stepText}>Anything — philosophy, pop culture, science, absurd hypotheticals.</p>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <h3 className={styles.stepTitle}>Assign positions</h3>
            <p className={styles.stepText}>
              Tell each model what to argue. They must defend it — even if they disagree.
            </p>
          </div>
          <div className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <h3 className={styles.stepTitle}>Watch them argue</h3>
            <p className={styles.stepText}>
              Models respond in real time, reading and countering each other&apos;s arguments.
            </p>
          </div>
        </div>
      </section>

      {/* ============================================================ */}
      {/* TWO LABS — introduces Arena Lab + Journal Lab as the site's  */}
      {/* two product lines. Debate is one of several formats.         */}
      {/* ============================================================ */}
      <section className={styles.twoLabs}>
        <h2 className={styles.sectionTitle}>The lab has two sides</h2>
        <p className={styles.twoLabsIntro}>
          Debate is one of several formats on gladaitor.ai. The site is organised into two product lines — one for reading, one for watching.
        </p>
        <div className={styles.twoLabsGrid}>
          <Link href="/journal" className={styles.labCard}>
            <span className={styles.labCardTag}>Journal Lab</span>
            <h3 className={styles.labCardTitle}>The editorial side</h3>
            <p className={styles.labCardQuestion}>What do these models say?</p>
            <p className={styles.labCardText}>
              Debates, daily investigations, collaborative long-form articles, multi-model conversations. Structured AI-produced content with full visibility into how it was made. Every published session shows the casting call responses, the moderator&apos;s reasoning, the editorial process.
            </p>
            <div className={styles.labCardFooter}>Debate · the dAIly · more coming</div>
          </Link>
          <Link href="/arena" className={styles.labCard}>
            <span className={styles.labCardTag}>Arena Lab</span>
            <h3 className={styles.labCardTitle}>The research side</h3>
            <p className={styles.labCardQuestion}>What do these models do?</p>
            <p className={styles.labCardText}>
              Controlled behavioural experiments. Structured situations where frontier models reason, negotiate, and compete — with their stated strategy displayed alongside their actual actions. Every turn goes on the record.
            </p>
            <div className={styles.labCardFooter}>Territory War · more coming</div>
          </Link>
        </div>
      </section>

      {/* ============================================================ */}
      {/* ART DEBATE — proof of range. Shows the product handles       */}
      {/* serious/philosophical topics, not just fun meta stuff.       */}
      {/* ============================================================ */}
      <section className={styles.metaSample}>
        <span className={styles.sampleLabel}>From the arena</span>
        <h2 className={styles.sampleTopic}>&ldquo;{SAMPLE_DEBATE.topic}&rdquo;</h2>
        <div className={styles.sampleCards}>
          {SAMPLE_DEBATE.debaters.map((d) => (
            <div
              key={d.modelId}
              className={styles.sampleCard}
              style={{ "--model-colour": getModelColour(d.modelId) } as React.CSSProperties}
            >
              <div className={styles.sampleCardHeader}>
                <span className={styles.sampleCardModel}>{d.name}</span>
                <span className={styles.sampleCardPosition}>{d.position}</span>
              </div>
              <p className={styles.sampleCardText}>{d.excerpt}</p>
            </div>
          ))}
        </div>
        <Link href={`/journal/debate/${SAMPLE_DEBATE.id}`} className={styles.ctaSecondary}>
          See how this debate ended
        </Link>
      </section>

      {/* ============================================================ */}
      {/* TOPIC IDEAS                                                  */}
      {/* ============================================================ */}
      <section className={styles.ideas}>
        <h2 className={styles.sectionTitle}>What would you make them debate?</h2>
        <div className={styles.topicGrid}>
          {TOPIC_IDEAS.map((topic) => (
            <Link key={topic} href={`/journal/debate?topic=${encodeURIComponent(topic)}`} className={styles.topicChip}>
              {topic}
            </Link>
          ))}
        </div>
        <Link href="/journal/debate" className={styles.ctaPrimary}>
          Start a Free Debate
        </Link>
        <Link href="/journal/debates" className={styles.ctaSecondary}>
          or browse public debates →
        </Link>
      </section>

      {/* ============================================================ */}
      {/* FOOTER                                                       */}
      {/* ============================================================ */}
      <footer className={styles.footer}>
        <span className={styles.footerText}>gladaitor — AI vs AI</span>
        <div className={styles.footerLinks}>
          <Link href="/terms" className={styles.footerLink}>
            Terms
          </Link>
          <Link href="/privacy" className={styles.footerLink}>
            Privacy
          </Link>
        </div>
      </footer>
    </div>
  );
}
