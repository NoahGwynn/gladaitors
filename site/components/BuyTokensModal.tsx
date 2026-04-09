// ============================================================================
// BuyTokensModal — token pack selection + embedded Stripe checkout
// ============================================================================
// Step 1: Pick a token pack
// Step 2: Stripe EmbeddedCheckout renders in-place
// ============================================================================

'use client';

import { useState, useCallback } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import {
  EmbeddedCheckoutProvider,
  EmbeddedCheckout,
} from '@stripe/react-stripe-js';
import { X, Coins } from 'lucide-react';
import styles from './BuyTokensModal.module.scss';

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!);

const TOKEN_PACKS = [
  { amount: 50, price: '£1', description: '~8 debates' },
  { amount: 150, price: '£2.50', description: '~25 debates', popular: true },
  { amount: 500, price: '£7', description: '~83 debates' },
];

interface BuyTokensModalProps {
  onClose: () => void;
  onSuccess?: () => void;
}

export default function BuyTokensModal({ onClose, onSuccess }: BuyTokensModalProps) {
  const [selectedPack, setSelectedPack] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [couponCode, setCouponCode] = useState('');
  const [couponLoading, setCouponLoading] = useState(false);
  const [couponSuccess, setCouponSuccess] = useState<string | null>(null);

  const fetchClientSecret = useCallback(async () => {
    if (!selectedPack) throw new Error('No pack selected');

    const res = await fetch('/api/tokens/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pack: selectedPack }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create checkout');
    }

    const { clientSecret } = await res.json();
    return clientSecret;
  }, [selectedPack]);

  async function redeemCoupon() {
    if (!couponCode.trim()) return;
    setCouponLoading(true);
    setError(null);
    setCouponSuccess(null);

    const res = await fetch('/api/tokens/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: couponCode }),
    });

    const data = await res.json();
    setCouponLoading(false);

    if (!res.ok) {
      setError(data.error || 'Invalid code');
      return;
    }

    setCouponSuccess(`+${data.tokens} tokens added!`);
    setCouponCode('');
    onSuccess?.();
  }

  async function handleComplete() {
    // Webhook may not have credited tokens yet — poll briefly
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
      onSuccess?.();
    }
    onClose();
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose}>
          <X size={18} />
        </button>

        {!selectedPack ? (
          <>
            <div className={styles.header}>
              <Coins size={24} className={styles.headerIcon} />
              <h2 className={styles.title}>Get More Tokens</h2>
              <p className={styles.subtitle}>Each token generates one AI argument in a debate.</p>
            </div>

            <div className={styles.packs}>
              {TOKEN_PACKS.map(pack => (
                <button
                  key={pack.amount}
                  className={`${styles.pack} ${pack.popular ? styles.packPopular : ''}`}
                  onClick={() => {
                    setError(null);
                    setSelectedPack(pack.amount);
                  }}
                >
                  {pack.popular && <span className={styles.popularBadge}>Most popular</span>}
                  <span className={styles.packAmount}>{pack.amount} tokens</span>
                  <span className={styles.packPrice}>{pack.price}</span>
                  <span className={styles.packDescription}>{pack.description}</span>
                </button>
              ))}
            </div>

            <div className={styles.couponSection}>
              <span className={styles.couponLabel}>Have a code?</span>
              <div className={styles.couponRow}>
                <input
                  className={styles.couponInput}
                  type="text"
                  placeholder="Enter code"
                  value={couponCode}
                  onChange={e => { setCouponCode(e.target.value); setError(null); setCouponSuccess(null); }}
                  onKeyDown={e => e.key === 'Enter' && redeemCoupon()}
                  disabled={couponLoading}
                />
                <button
                  className={styles.couponButton}
                  onClick={redeemCoupon}
                  disabled={couponLoading || !couponCode.trim()}
                >
                  {couponLoading ? '...' : 'Redeem'}
                </button>
              </div>
              {couponSuccess && <span className={styles.couponSuccess}>{couponSuccess}</span>}
            </div>

            {error && <p className={styles.error}>{error}</p>}
          </>
        ) : (
          <>
            <div className={styles.header}>
              <h2 className={styles.title}>Complete Purchase</h2>
              <button className={styles.backLink} onClick={() => setSelectedPack(null)}>
                Choose a different pack
              </button>
            </div>

            <div className={styles.checkoutContainer}>
              <EmbeddedCheckoutProvider
                stripe={stripePromise}
                options={{
                  fetchClientSecret,
                  onComplete: handleComplete,
                }}
              >
                <EmbeddedCheckout />
              </EmbeddedCheckoutProvider>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
