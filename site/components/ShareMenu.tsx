// ============================================================================
// ShareMenu — share via native share sheet or fallback dropdown
// ============================================================================
// On mobile: uses Web Share API (native share sheet with all apps)
// On desktop: shows a dropdown with common share options + copy link
// ============================================================================

'use client';

import { useState, useRef, useEffect } from 'react';
import { Share2, Link2, Mail } from 'lucide-react';
import { FaWhatsapp, FaXTwitter, FaRedditAlien, FaFacebookF, FaLinkedinIn } from 'react-icons/fa6';
import styles from './ShareMenu.module.scss';

interface ShareMenuProps {
  url: string;
  title: string;
  text?: string;
  variant?: 'icon' | 'primary';
  label?: string;
  dropdownPosition?: 'below' | 'above';
}

export default function ShareMenu({
  url,
  title,
  text,
  variant = 'icon',
  label = 'Share This Debate',
  dropdownPosition = 'below',
}: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  async function handleShare() {
    // Use native share sheet on mobile only — desktop gets the dropdown
    const isMobile = /iPhone|iPad|Android|webOS/i.test(navigator.userAgent);

    if (isMobile && navigator.share) {
      try {
        await navigator.share({
          title,
          text: text || title,
          url,
        });
        return;
      } catch {
        // User cancelled — fall through to dropdown
      }
    }

    setOpen(!open);
  }

  function copyLink() {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
      setOpen(false);
    }, 1500);
  }

  const encodedUrl = encodeURIComponent(url);
  const encodedTitle = encodeURIComponent(title);
  const encodedText = encodeURIComponent(text || title);

  const shareOptions = [
    {
      label: 'Copy link',
      icon: <Link2 size={16} />,
      action: copyLink,
    },
    {
      label: 'WhatsApp',
      icon: <FaWhatsapp size={16} />,
      action: () => window.open(`https://wa.me/?text=${encodedText}%20${encodedUrl}`, '_blank'),
    },
    {
      label: 'X',
      icon: <FaXTwitter size={16} />,
      action: () => window.open(`https://x.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`, '_blank'),
    },
    {
      label: 'Reddit',
      icon: <FaRedditAlien size={16} />,
      action: () => window.open(`https://reddit.com/submit?url=${encodedUrl}&title=${encodedTitle}`, '_blank'),
    },
    {
      label: 'Facebook',
      icon: <FaFacebookF size={16} />,
      action: () => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`, '_blank'),
    },
    {
      label: 'LinkedIn',
      icon: <FaLinkedinIn size={16} />,
      action: () => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`, '_blank'),
    },
    {
      label: 'Email',
      icon: <Mail size={16} />,
      action: () => window.open(`mailto:?subject=${encodedTitle}&body=${encodedText}%0A%0A${encodedUrl}`, '_blank'),
    },
  ];

  const triggerClass = variant === 'primary'
    ? styles.triggerPrimary
    : `${styles.trigger} ${styles.triggerIcon}`;

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        className={triggerClass}
        onClick={handleShare}
        title="Share"
      >
        {variant === 'primary' ? (
          label
        ) : (
          <Share2 size={16} />
        )}
      </button>

      {open && (
        <div className={`${styles.dropdown} ${dropdownPosition === 'above' ? styles.dropdownAbove : ''}`}>
          {copied ? (
            <div className={styles.copied}>Link copied!</div>
          ) : (
            shareOptions.map((opt) => (
              <button key={opt.label} className={styles.option} onClick={opt.action}>
                <span className={styles.optionIcon}>{opt.icon}</span>
                {opt.label}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
