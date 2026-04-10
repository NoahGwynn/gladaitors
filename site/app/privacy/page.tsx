import type { Metadata } from "next";
import Link from "next/link";
import styles from "../legal.module.scss";

export const metadata: Metadata = {
  title: "Privacy Policy — gladaitor",
};

export default function PrivacyPage() {
  return (
    <div className={styles.page}>
      <h1 className={styles.title}>Privacy Policy</h1>
      <p className={styles.updated}>Last updated: 7 April 2026</p>

      <section className={styles.section}>
        <h2>1. What we collect</h2>
        <p>We collect the minimum data needed to operate the Service:</p>
        <ul>
          <li>
            <strong>Account information:</strong> email address and hashed password (if you create an account). We do
            not collect your name or other personal details.
          </li>
          <li>
            <strong>Session identifier:</strong> a random ID stored in your browser&apos;s localStorage to track
            anonymous token balances and debate ownership. This is not a tracking cookie.
          </li>
          <li>
            <strong>Debate content:</strong> the topics, positions, and AI-generated arguments you create. These are
            stored in our database.
          </li>
          <li>
            <strong>Payment information:</strong> processed entirely by Stripe. We do not store, see, or have access to
            your card details. We receive only a confirmation of payment and the associated token amount.
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>2. How we use your data</h2>
        <ul>
          <li>Account management and authentication</li>
          <li>Token balance tracking and debate storage</li>
          <li>Processing payments via Stripe</li>
          <li>Displaying shared debates to users with the link</li>
        </ul>
        <p>
          We do not sell your data. We do not use your data for advertising. We do not build user profiles for marketing
          purposes.
        </p>
      </section>

      <section className={styles.section}>
        <h2>3. Third-party services</h2>
        <p>We share data with the following third parties, only as needed to operate the Service:</p>
        <ul>
          <li>
            <strong>Supabase</strong> — database hosting and authentication. Your email, debate content, and token
            balances are stored in Supabase.
          </li>
          <li>
            <strong>Stripe</strong> — payment processing. Stripe receives your email and payment details when you
            purchase tokens. See{" "}
            <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer">
              Stripe&apos;s Privacy Policy
            </a>
            .
          </li>
          <li>
            <strong>AI model providers</strong> — Anthropic (Claude), OpenAI (GPT-4o), and Google (Gemini). Debate
            topics, positions, and prior arguments are sent to these providers to generate responses. See their
            respective privacy policies:{" "}
            <a href="https://www.anthropic.com/privacy" target="_blank" rel="noopener noreferrer">
              Anthropic
            </a>
            ,{" "}
            <a href="https://openai.com/privacy" target="_blank" rel="noopener noreferrer">
              OpenAI
            </a>
            ,{" "}
            <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
              Google
            </a>
            .
          </li>
          <li>
            <strong>Vercel</strong> — hosting. Vercel may process server logs containing IP addresses. See{" "}
            <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer">
              Vercel&apos;s Privacy Policy
            </a>
            .
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>4. Data retention</h2>
        <ul>
          <li>
            <strong>Anonymous debates</strong> expire and are automatically deleted after 30 days of inactivity.
          </li>
          <li>
            <strong>Registered user debates</strong> are stored indefinitely until you delete them or your account.
          </li>
          <li>
            <strong>Anonymous sessions</strong> are periodically cleaned up after inactivity.
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <h2>5. Your rights</h2>
        <p>You can:</p>
        <ul>
          <li>Delete individual debates at any time from the debate history</li>
          <li>Request deletion of your account and all associated data by contacting us</li>
          <li>Export your debate content using the &ldquo;Copy Text&rdquo; feature</li>
        </ul>
        <p>
          If you are in the EU/EEA, you have additional rights under GDPR including the right to access, rectify, and
          port your data. Contact us to exercise these rights.
        </p>
      </section>

      <section className={styles.section}>
        <h2>6. Cookies and local storage</h2>
        <p>
          We do not use tracking cookies. We use browser localStorage to store a session identifier for anonymous users.
          This is a functional requirement, not tracking. No analytics or advertising cookies are used.
        </p>
      </section>

      <section className={styles.section}>
        <h2>7. Children</h2>
        <p>
          The Service is not intended for anyone under 18. We do not knowingly collect data from anyone under 18. If you
          believe a minor has provided us with personal data, please contact us.
        </p>
      </section>

      <section className={styles.section}>
        <h2>8. Changes to this policy</h2>
        <p>
          We may update this policy from time to time. Changes will be reflected by the &ldquo;Last updated&rdquo; date
          above. Continued use of the Service after changes constitutes acceptance.
        </p>
      </section>

      <section className={styles.section}>
        <h2>9. Contact</h2>
        <p>
          Questions about your privacy? Contact us at <a href="mailto:hello@gladaitor.ai">hello@gladaitor.ai</a>.
        </p>
      </section>

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
