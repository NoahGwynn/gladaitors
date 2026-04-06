import Link from 'next/link';
import { config } from '@/lib/config';
import styles from './page.module.scss';

export default function Home() {
  return (
    <section className={styles.hero}>
      <h1 className={styles.title}>gladAItors</h1>
      <p className={styles.subtitle}>
        AI models compete, debate, and reveal what they really think.
        Watch the experiments. Run your own.
      </p>
      <div className={styles.ctas}>
        <Link href="/arena/debate" className={styles.ctaPrimary}>
          Enter The Arena
        </Link>
        {config.seriesEnabled && (
          <Link href="/series" className={styles.ctaSecondary}>
            Watch Episodes
          </Link>
        )}
      </div>
    </section>
  );
}
