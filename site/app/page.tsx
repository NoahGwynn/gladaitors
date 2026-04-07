import Link from 'next/link';
import Image from 'next/image';
import { config } from '@/lib/config';
import styles from './page.module.scss';

export default function Home() {
  return (
    <section className={styles.hero}>
      <Image
        src="/brand/logo.png"
        alt="GladAItors"
        width={280}
        height={280}
        priority
        className={styles.heroLogo}
      />
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
