// ============================================================================
// Nav — site navigation with auth state and token balance
// ============================================================================
// Desktop: inline links + token button + notifications
// Mobile:  logo on left, hamburger on right that opens a slide-down drawer
//          containing all the same actions in a vertical stack.
// ============================================================================

"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { config } from "@/lib/config";
import { createClient } from "@/lib/supabase";
import { signOut } from "@/lib/auth";
import { fetchTokenBalance, notifyBalanceChanged, onBalanceChanged } from "@/lib/tokens";
import AuthModal from "./AuthModal";
import BuyTokensModal from "./BuyTokensModal";
import NotificationsBell from "./NotificationsBell";
import { Coins, LogOut, Plus, Menu, X } from "lucide-react";
import styles from "./Nav.module.scss";

export default function Nav() {
  const pathname = usePathname();
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [tokenBalance, setTokenBalance] = useState<number | null>(null);
  const [showAuth, setShowAuth] = useState(false);
  const [showBuyTokens, setShowBuyTokens] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false); // desktop user dropdown
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false); // mobile hamburger drawer
  const menuRef = useRef<HTMLDivElement>(null);

  /** Returns the active class if the link matches the current route. */
  const linkClass = (href: string, base: string) => {
    const isActive = href === '/'
      ? pathname === '/'
      : pathname.startsWith(href);
    return `${base} ${isActive ? styles.linkActive : ''}`;
  };

  const loadBalance = useCallback(async () => {
    const balance = await fetchTokenBalance();
    setTokenBalance(balance);
  }, []);

  useEffect(() => {
    const supabase = createClient();
    loadBalance();

    supabase.auth.getUser().then(({ data: { user: u } }) => {
      setUser(u ? { id: u.id, email: u.email || undefined } : null);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user;
      setUser(u ? { id: u.id, email: u.email || undefined } : null);
      loadBalance();
    });

    const cleanupBalanceListener = onBalanceChanged(loadBalance);

    return () => {
      subscription.unsubscribe();
      cleanupBalanceListener();
    };
  }, [loadBalance]);

  // Close desktop menu on click outside
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [menuOpen]);

  // Lock body scroll while the mobile drawer is open
  useEffect(() => {
    if (mobileMenuOpen) {
      const original = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [mobileMenuOpen]);

  async function handleSignOut() {
    setMenuOpen(false);
    setMobileMenuOpen(false);
    await signOut();
    setUser(null);
    loadBalance();
  }

  function closeMobileMenu() {
    setMobileMenuOpen(false);
  }

  return (
    <>
      <nav className={styles.nav}>
        <Link href="/" className={styles.logo} aria-label="gladaitor" onClick={closeMobileMenu}>
          <span className={styles.logoText}>
            Glad<span className={styles.logoAi}>AI</span>tor
          </span>
        </Link>

        {/* ============================================================ */}
        {/* DESKTOP LINKS — hidden on mobile via CSS                     */}
        {/* ============================================================ */}
        <div className={styles.links}>
          {config.seriesEnabled && (
            <Link href="/series" className={styles.link}>
              Series
            </Link>
          )}
          <Link href="/arena/territory-war" className={linkClass('/arena', styles.link)}>
            Territory Wars
          </Link>
          <Link href="/journal/debate" className={linkClass('/journal/debate', styles.link)}>
            Debate
          </Link>

          {user ? (
            <>
              <NotificationsBell />
              <div className={styles.userMenu} ref={menuRef}>
                <button className={styles.tokenButton} onClick={() => setMenuOpen(!menuOpen)}>
                  <Coins size={14} />
                  <span className={styles.tokenCount}>{tokenBalance ?? "–"}</span>
                </button>

                {menuOpen && (
                  <div className={styles.dropdown}>
                    <button
                      className={styles.dropdownItem}
                      onClick={() => {
                        setMenuOpen(false);
                        setShowBuyTokens(true);
                      }}
                    >
                      <Plus size={14} />
                      Buy Tokens
                    </button>
                    <button className={styles.dropdownItem} onClick={handleSignOut}>
                      <LogOut size={14} />
                      Sign Out
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : config.openAccess ? null : (
            <button className={styles.authButton} onClick={() => setShowAuth(true)}>
              Sign In
            </button>
          )}
        </div>

        {/* ============================================================ */}
        {/* MOBILE HAMBURGER — hidden on desktop via CSS                 */}
        {/* ============================================================ */}
        <button
          className={styles.hamburger}
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
        >
          {mobileMenuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </nav>

      {/* ============================================================ */}
      {/* MOBILE DRAWER                                                */}
      {/* ============================================================ */}
      {mobileMenuOpen && (
        <>
          <div className={styles.mobileBackdrop} onClick={closeMobileMenu} />
          <div className={styles.mobileDrawer}>
            {user && (
              <div className={styles.mobileTokenRow}>
                <Coins size={16} />
                <span className={styles.mobileTokenCount}>{tokenBalance ?? "–"}</span>
                <span className={styles.mobileTokenLabel}>tokens</span>
              </div>
            )}

            <Link href="/arena/territory-war" className={linkClass('/arena', styles.mobileLink)} onClick={closeMobileMenu}>
              Territory Wars
            </Link>
            <Link href="/journal/debate" className={linkClass('/journal/debate', styles.mobileLink)} onClick={closeMobileMenu}>
              Debate
            </Link>
            {config.seriesEnabled && (
              <Link href="/series" className={styles.mobileLink} onClick={closeMobileMenu}>
                Series
              </Link>
            )}

            <div className={styles.mobileDivider} />

            {user ? (
              <>
                <button
                  className={styles.mobileLink}
                  onClick={() => {
                    closeMobileMenu();
                    setShowBuyTokens(true);
                  }}
                >
                  <Plus size={16} />
                  Buy Tokens
                </button>
                <button className={styles.mobileLink} onClick={handleSignOut}>
                  <LogOut size={16} />
                  Sign Out
                </button>
              </>
            ) : config.openAccess ? null : (
              <button
                className={styles.mobileSignIn}
                onClick={() => {
                  closeMobileMenu();
                  setShowAuth(true);
                }}
              >
                Sign In
              </button>
            )}
          </div>
        </>
      )}

      {showAuth && (
        <AuthModal
          onClose={() => setShowAuth(false)}
          onSuccess={() => {
            setShowAuth(false);
            loadBalance();
            notifyBalanceChanged();
          }}
        />
      )}

      {showBuyTokens && (
        <BuyTokensModal
          onClose={() => setShowBuyTokens(false)}
          onSuccess={() => {
            loadBalance();
            notifyBalanceChanged();
            setShowBuyTokens(false);
          }}
        />
      )}
    </>
  );
}
