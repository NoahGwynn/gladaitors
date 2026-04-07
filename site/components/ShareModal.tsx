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
}

export default function ShareModal({ url, topic, modelNames, onClose }: ShareModalProps) {
  const [copied, setCopied] = useState(false);

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
