// ============================================================================
// NotificationsBell — bell icon + unread badge + dropdown panel
// ============================================================================
// Renders only for logged-in users. Polls /api/notifications periodically and
// on mount. Clicking the bell opens a dropdown with the most recent
// notifications and marks them all as read.
// ============================================================================

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import styles from './NotificationsBell.module.scss';

interface Notification {
  id: string;
  type: 'vote_received' | 'view_milestone';
  content_id: string | null;
  content_type: string | null;
  data: { topic?: string; view_count?: number; voted_for?: string } | null;
  read: boolean;
  created_at: string;
}

export default function NotificationsBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch {
      // Silent fail — notifications aren't critical
    }
  }, []);

  // Initial load + poll every 60 seconds
  useEffect(() => {
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  }, [load]);

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

  async function handleOpen() {
    setOpen(true);
    // Refresh and mark all as read on open
    await load();
    if (unreadCount > 0) {
      try {
        await fetch('/api/notifications', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        setUnreadCount(0);
        // Optimistically mark local notifications as read so the dropdown shows them as read on next open
        setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      } catch {
        // Silent fail
      }
    }
  }

  function formatRelativeTime(iso: string): string {
    const now = Date.now();
    const then = new Date(iso).getTime();
    const diff = Math.floor((now - then) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    return new Date(iso).toLocaleDateString();
  }

  function notificationText(n: Notification): string {
    const topic = n.data?.topic || 'a debate';
    if (n.type === 'vote_received') {
      return `Someone voted on your debate "${topic}"`;
    }
    if (n.type === 'view_milestone') {
      const count = n.data?.view_count || 0;
      return `Your debate "${topic}" reached ${count} views`;
    }
    return 'You have a new notification';
  }

  function notificationHref(n: Notification): string {
    if (n.content_type === 'debate' && n.content_id) {
      return `/arena/debate/${n.content_id}`;
    }
    return '/arena/debate';
  }

  return (
    <div className={styles.wrapper} ref={wrapperRef}>
      <button
        className={styles.bell}
        onClick={() => open ? setOpen(false) : handleOpen()}
        aria-label="Notifications"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className={styles.badge}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.dropdown}>
          <div className={styles.dropdownHeader}>Notifications</div>
          {notifications.length === 0 ? (
            <div className={styles.empty}>No notifications yet.</div>
          ) : (
            <div className={styles.list}>
              {notifications.map(n => (
                <Link
                  key={n.id}
                  href={notificationHref(n)}
                  className={styles.item}
                  onClick={() => setOpen(false)}
                >
                  <span className={styles.itemText}>{notificationText(n)}</span>
                  <span className={styles.itemTime}>{formatRelativeTime(n.created_at)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
