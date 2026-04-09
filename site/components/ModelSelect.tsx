// ============================================================================
// ModelSelect — custom dropdown for selecting AI model variants
// ============================================================================
// Reads from the central model registry. Shows family colour, name, tier,
// and token cost for each option.
// ============================================================================

'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown, LockKeyhole } from 'lucide-react';
import { MODELS, getModel, getModelColour } from '@/lib/models';
import styles from './ModelSelect.module.scss';

interface ModelSelectProps {
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /** Whether the current viewer is signed in. Premium-tier models are
   *  locked for anonymous users. */
  isLoggedIn?: boolean;
  /** Called when an anonymous user clicks a locked premium option.
   *  The page typically opens its auth modal in response. */
  onPremiumLocked?: () => void;
}

export default function ModelSelect({
  value, onChange, disabled, isLoggedIn = true, onPremiumLocked,
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selected = MODELS.find(m => m.id === value);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        className={styles.trigger}
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        type="button"
      >
        <span className={styles.triggerLabel}>
          {selected?.name || 'Select model'}
          {selected?.version && <span className={styles.optionVersion}> {selected.version}</span>}
        </span>
        <ChevronDown size={16} className={`${styles.arrow} ${open ? styles.arrowOpen : ''}`} />
      </button>

      {open && (
        <div className={styles.dropdown}>
          {MODELS.map(model => {
            const isActive = model.id === value;
            const isLocked = !isLoggedIn && model.tier === 'premium';
            return (
              <button
                key={model.id}
                className={`${styles.option} ${isActive ? styles.optionActive : ''} ${isLocked ? styles.optionLocked : ''}`}
                onClick={() => {
                  if (isLocked) {
                    setOpen(false);
                    onPremiumLocked?.();
                    return;
                  }
                  onChange(model.id);
                  setOpen(false);
                }}
                type="button"
              >
                <span
                  className={styles.optionDot}
                  style={{ background: getModelColour(model.id) }}
                />
                <span className={styles.optionName}>
                  {model.name}
                  {model.version && <span className={styles.optionVersion}> {model.version}</span>}
                </span>
                {isLocked ? (
                  <span className={styles.optionLockBadge}>
                    <LockKeyhole size={11} />
                    Sign up
                  </span>
                ) : (
                  <span className={styles.optionCost}>
                    {model.tokenCost} {model.tokenCost === 1 ? 'token' : 'tokens'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Re-export for callers that want to read model info
export { getModel };
