// ============================================================================
// StatusBadge — reusable status indicator
// ============================================================================
// Displays model status with colour-coded styling and animations.
// Used in ModelPanel headers and potentially in GameHeader.
//
// Usage:
//   <StatusBadge status="active" />
//   <StatusBadge status="thinking" />
//   <StatusBadge status="winner" />
// ============================================================================

import type { BadgeStatus } from '@/lib/types';
import styles from './StatusBadge.module.scss';

const STATUS_LABELS: Record<BadgeStatus, string> = {
  active: 'Active',
  thinking: 'Thinking',
  timeout: 'Timed Out',
  rate_limited: 'Rate Limited',
  invalid: 'Invalid',
  winner: 'Winner',
  eliminated: 'Eliminated',
};

interface StatusBadgeProps {
  status: BadgeStatus;
}

export default function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
