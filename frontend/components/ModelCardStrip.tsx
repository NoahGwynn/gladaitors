// ============================================================================
// ModelCardStrip — compact model cards stacked at the top of the right panel
// ============================================================================
// Shows model name, colour, score, stats, and status badge in a single row each.
//
// Usage:
//   <ModelCardStrip models={gameState.models} />
// ============================================================================

import type { ModelState } from '@/lib/types';
import StatusBadge from './StatusBadge';
import styles from './ModelCardStrip.module.scss';

interface ModelCardStripProps {
  models: ModelState[];
}

export default function ModelCardStrip({ models }: ModelCardStripProps) {
  return (
    <div className={styles.strip}>
      {models.map((model) => {
        const cardClasses = [
          styles.card,
          styles[model.id],
          model.status === 'eliminated' ? styles.eliminated : '',
          model.status === 'winner' ? styles.winner : '',
        ].filter(Boolean).join(' ');

        return (
          <div key={model.id} className={cardClasses}>
            <div className={styles.left}>
              <div className={styles.dot} />
              <span className={styles.name}>{model.name}</span>
              <StatusBadge status={model.status} />
            </div>
            <div className={styles.right}>
              <div className={styles.stats}>
                {Object.entries(model.stats).map(([key, value]) => (
                  <span key={key}>{key}: {value}</span>
                ))}
              </div>
              <span className={styles.score}>
                {model.primary_metric}
                <span className={styles.scoreLabel}>pts</span>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
