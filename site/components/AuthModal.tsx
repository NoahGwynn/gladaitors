// ============================================================================
// AuthModal — sign up / sign in modal
// ============================================================================

'use client';

import { useState } from 'react';
import { signUp, signIn } from '@/lib/auth';
import { X } from 'lucide-react';
import styles from './AuthModal.module.scss';

interface AuthModalProps {
  onClose: () => void;
  onSuccess: () => void;
  initialMode?: 'signin' | 'signup';
  message?: string;
}

export default function AuthModal({ onClose, onSuccess, initialMode = 'signin', message }: AuthModalProps) {
  const [mode, setMode] = useState(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passwordMismatch = mode === 'signup' && confirmPassword.length > 0 && password !== confirmPassword;
  const canSubmit = email.length > 0 && password.length >= 6 &&
    (mode === 'signin' || (confirmPassword.length > 0 && !passwordMismatch));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    if (mode === 'signup' && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    setError(null);

    const { error: authError } = mode === 'signup'
      ? await signUp(email, password)
      : await signIn(email, password);

    setLoading(false);

    if (authError) {
      setError(authError.message);
    } else {
      onSuccess();
    }
  }

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose}><X size={18} /></button>

        <h2 className={styles.title}>
          {mode === 'signup' ? 'Create Account' : 'Welcome Back'}
        </h2>

        {message && <p className={styles.message}>{message}</p>}

        <form className={styles.form} onSubmit={handleSubmit}>
          <input
            className={styles.input}
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoFocus
            required
          />
          <input
            className={styles.input}
            type="password"
            placeholder="Password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            minLength={6}
          />
          {mode === 'signup' && (
            <input
              className={`${styles.input} ${passwordMismatch ? styles.inputError : ''}`}
              type="password"
              placeholder="Confirm password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              required
              minLength={6}
            />
          )}

          {passwordMismatch && (
            <p className={styles.error}>Passwords do not match</p>
          )}

          <button className={styles.submitButton} type="submit" disabled={!canSubmit || loading}>
            {loading ? 'Loading...' : mode === 'signup' ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.switchMode}>
          {mode === 'signin' ? (
            <>New here? <button onClick={() => { setMode('signup'); setError(null); }}>Create an account</button></>
          ) : (
            <>Have an account? <button onClick={() => { setMode('signin'); setError(null); }}>Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}
