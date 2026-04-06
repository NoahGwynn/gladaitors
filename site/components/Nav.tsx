// ============================================================================
// Nav — site navigation with auth state
// ============================================================================

'use client';

import Link from 'next/link';
import { config } from '@/lib/config';
import styles from './Nav.module.scss';

export default function Nav() {
  // TODO: wire to Supabase auth state
  const user = null;
  const tokenBalance = 0;

  return (
    <nav className={styles.nav}>
      <Link href="/" className={styles.logo}>
        &#x2694;&#xFE0F; gladAItors
      </Link>

      <div className={styles.links}>
        {config.seriesEnabled && (
          <Link href="/series" className={styles.link}>Series</Link>
        )}
        <Link href="/arena/debate" className={styles.link}>The Arena</Link>

        {user ? (
          <>
            <span className={styles.tokens}>{tokenBalance} tokens</span>
            <button className={styles.authButton}>Account</button>
          </>
        ) : (
          <button className={styles.authButton}>Sign In</button>
        )}
      </div>
    </nav>
  );
}
