// ============================================================================
// ModelPanel — displays a single model's status, metrics, and last action
// ============================================================================
// One panel per model, stacked vertically in the right sidebar.
// The panel's left accent, dot, and metric bar all use the model's colour.
//
// Stats are data-driven — the component renders whatever key-value pairs
// the game engine provides, so it works for both Trading Pit and Territory War
// without any challenge-specific code.
//
// Usage:
//   <ModelPanel model={modelState} />
// ============================================================================

import type { ModelState } from '@/lib/types';
import StatusBadge from './StatusBadge';
import styles from './ModelPanel.module.scss';

interface ModelPanelProps {
  model: ModelState;
  /** Maximum value for the primary metric bar (e.g. 100 for %, or max portfolio value) */
  metricMax: number;
}

export default function ModelPanel({ model, metricMax }: ModelPanelProps) {
  const fillPercent = metricMax > 0
    ? Math.min((model.primary_metric / metricMax) * 100, 100)
    : 0;

  const panelClasses = [
    styles.panel,
    styles[model.id],                                      // sets --model-colour
    model.status === 'eliminated' ? styles.eliminated : '',
    model.status === 'winner' ? styles.winner : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={panelClasses}>
      {/* Header: model identity + status badge */}
      <div className={styles.header}>
        <div className={styles.identity}>
          <div className={styles.dot} />
          <span className={styles.name}>{model.name}</span>
        </div>
        <StatusBadge status={model.status} />
      </div>

      {/* Primary metric bar */}
      <div className={styles.metric}>
        <div className={styles.metricRow}>
          <span className={styles.metricValue}>
            {typeof model.primary_metric === 'number'
              ? model.primary_metric.toLocaleString()
              : model.primary_metric}
          </span>
          <span className={styles.metricLabel}>{model.primary_metric_label}</span>
        </div>
        <div className={styles.metricBar}>
          <div
            className={styles.metricFill}
            style={{ width: `${fillPercent}%` }}
          />
        </div>
      </div>

      {/* Secondary stats — data-driven, renders any key-value pairs */}
      {Object.keys(model.stats).length > 0 && (
        <div className={styles.stats}>
          {Object.entries(model.stats).map(([key, value]) => (
            <div key={key} className={styles.stat}>
              <span className={styles.statValue}>{value}</span>
              <span className={styles.statLabel}>{key}</span>
            </div>
          ))}
        </div>
      )}

      {/* Last action */}
      {model.last_action && (
        <div className={styles.lastAction}>
          &rarr; {model.last_action}
        </div>
      )}
    </div>
  );
}
