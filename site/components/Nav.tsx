// ============================================================================
// Nav — site navigation with auth state
// ============================================================================

'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { config } from '@/lib/config';
import { createClient } from '@/lib/supabase';
import { signOut } from '@/lib/auth';
import AuthModal from './AuthModal';
import styles from './Nav.module.scss';

export default function Nav() {
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [tokenBalance, setTokenBalance] = useState(0);
  const [showAuth, setShowAuth] = useState(false);

  useEffect(() => {
    const supabase = createClient();

    supabase.auth.getUser().then(({ data: { user: u } }) => {
      setUser(u ? { id: u.id, email: u.email || undefined } : null);
      if (u) {
        supabase.from('profiles').select('token_balance').eq('id', u.id).single()
          .then(({ data }) => setTokenBalance(data?.token_balance || 0));
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      setUser(u ? { id: u.id, email: u.email || undefined } : null);
      if (u) {
        supabase.from('profiles').select('token_balance').eq('id', u.id).single()
          .then(({ data }) => setTokenBalance(data?.token_balance || 0));
      } else {
        setTokenBalance(0);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function handleSignOut() {
    await signOut();
    setUser(null);
    setTokenBalance(0);
  }

  return (
    <>
      <nav className={styles.nav}>
        <Link href="/" className={styles.logo}>
          <img src="/brand/logo-text.png" alt="GladAItors" height={28} />
        </Link>

        <div className={styles.links}>
          {config.seriesEnabled && (
            <Link href="/series" className={styles.link}>Series</Link>
          )}
          <Link href="/arena/debate" className={styles.link}>The Arena</Link>

          {user ? (
            <>
              <span className={styles.tokens}>{tokenBalance} tokens</span>
              <button className={styles.authButton} onClick={handleSignOut}>Sign Out</button>
            </>
          ) : (
            <button className={styles.authButton} onClick={() => setShowAuth(true)}>Sign In</button>
          )}
        </div>
      </nav>

      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onSuccess={() => setShowAuth(false)}
        />
      )}
    </>
  );
}
