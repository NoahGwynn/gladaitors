// ============================================================================
// ModelSelect — custom dropdown for selecting AI models
// ============================================================================
// Replaces the native <select> to match the dark theme.
// ============================================================================

'use client';

import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import styles from './ModelSelect.module.scss';

const MODEL_COLOURS: Record<string, string> = {
  claude: '#7C3AED',
  gpt4o: '#10B981',
  gemini: '#3B82F6',
};

interface ModelOption {
  id: string;
  name: string;
}

interface ModelSelectProps {
  value: string;
  options: ModelOption[];
  disabledIds: Set<string>;
  onChange: (id: string) => void;
  disabled?: boolean;
}

export default function ModelSelect({ value, options, disabledIds, onChange, disabled }: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.id === value);

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
        {selected?.name || 'Select model'}
        <ChevronDown size={16} className={`${styles.arrow} ${open ? styles.arrowOpen : ''}`} />
      </button>

      {open && (
        <div className={styles.dropdown}>
          {options.map(option => {
            const isDisabled = disabledIds.has(option.id) && option.id !== value;
            return (
              <button
                key={option.id}
                className={`${styles.option} ${isDisabled ? styles.optionDisabled : ''} ${option.id === value ? styles.optionActive : ''}`}
                onClick={() => {
                  if (!isDisabled) {
                    onChange(option.id);
                    setOpen(false);
                  }
                }}
                type="button"
              >
                <span
                  className={styles.optionDot}
                  style={{ background: MODEL_COLOURS[option.id] || '#888' }}
                />
                {option.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
