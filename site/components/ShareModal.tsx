// ============================================================================
// ShareModal — full share experience for post-debate sharing
// ============================================================================
// Shows a preview of what's being shared, social options as a grid,
// and a copy-link bar at the bottom.
// ============================================================================

'use client';

import { useState } from 'react';
import { X, Mail } from 'lucide-react';
import { FaWhatsapp, FaXTwitter, FaRedditAlien, FaFacebookF, FaLinkedinIn } from 'react-icons/fa6';
import { Link2 } from 'lucide-react';
import styles from './ShareModal.module.scss';

interface ShareModalProps {
  url: string;
  topic: string;
  modelNames: string[];
  onClose: () => void;
  /** Whether the debate is currently listed in the public /explore feed.
   *  If undefined, the public-listing toggle is hidden entirely (e.g.
   *  anonymous viewers can't change visibility, all-refused debates
   *  shouldn't be promoted). */
  isPublic?: boolean;
  /** Called when the user toggles the public listing. */
  onTogglePublic?: (next: boolean) => void;
}

export default function ShareModal({
  url, topic, modelNames, onClose, isPublic, onTogglePublic,
}: ShareModalProps) {
  const [copied, setCopied] = useState(false);
  const showPublicToggle = typeof isPublic === 'boolean' && onTogglePublic !== undefined;

  const encodedUrl = encodeURIComponent(url);
  const shareText = `Watch ${modelNames.join(' vs ')} debate: "${topic}"`;
  const encodedText = encodeURIComponent(shareText);
  const encodedTitle = encodeURIComponent(`AI Debate: ${topic}`);

  function copyLink() {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const socials = [
    {
      label: 'WhatsApp',
      icon: <FaWhatsapp size={20} />,
      action: () => window.open(`https://wa.me/?text=${encodedText}%20${encodedUrl}`, '_blank'),
    },
    {
      label: 'X',
      icon: <FaXTwitter size={20} />,
      action: () => window.open(`https://x.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`, '_blank'),
    },
    {
      label: 'Reddit',
      icon: <FaRedditAlien size={20} />,
      action: () => window.open(`https://reddit.com/submit?url=${encodedUrl}&title=${encodedTitle}`, '_blank'),
    },
    {
      label: 'Facebook',
      icon: <FaFacebookF size={20} />,
      action: () => window.open(`https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`, '_blank'),
    },
    {
      label: 'LinkedIn',
      icon: <FaLinkedinIn size={20} />,
      action: () => window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`, '_blank'),
    },
    {
      label: 'Email',
      icon: <Mail size={20} />,
      action: () => window.open(`mailto:?subject=${encodedTitle}&body=${encodedText}%0A%0A${encodedUrl}`, '_blank'),
    },
  ];

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <button className={styles.close} onClick={onClose}>
          <X size={18} />
        </button>

        <h2 className={styles.title}>Share this debate</h2>

        <div className={styles.preview}>
          <div className={styles.previewTopic}>{topic}</div>
          <div className={styles.previewModels}>{modelNames.join(' vs ')}</div>
        </div>

        {showPublicToggle && (
          <label className={`${styles.publicRow} ${!isPublic ? styles.publicRowOff : ''}`}>
            <input
              type="checkbox"
              className={styles.publicCheckbox}
              checked={!!isPublic}
              onChange={e => onTogglePublic?.(e.target.checked)}
            />
            <div className={styles.publicText}>
              <span className={styles.publicLabel}>
                {isPublic ? 'Listed on /explore' : 'Also publish to /explore'}
              </span>
              <span className={styles.publicDescription}>
                {isPublic
                  ? 'Anyone browsing the explore feed can find this debate.'
                  : 'Let anyone browsing /explore discover it, not just people with the link.'}
              </span>
            </div>
          </label>
        )}

        <div className={styles.options}>
          {socials.map(s => (
            <button key={s.label} className={styles.option} onClick={s.action}>
              <span className={styles.optionIcon}>{s.icon}</span>
              {s.label}
            </button>
          ))}
        </div>

        <div className={styles.copyBar}>
          <input
            className={styles.linkInput}
            value={url}
            readOnly
            onClick={e => (e.target as HTMLInputElement).select()}
          />
          <button
            className={`${styles.copyButton} ${copied ? styles.copiedButton : ''}`}
            onClick={copyLink}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
