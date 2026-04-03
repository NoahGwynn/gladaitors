// ============================================================================
// ModelPanelList — renders the right sidebar with one ModelPanel per model
// ============================================================================
// Wraps ModelPanel components in a vertical stack.
// Receives the full models array from game state.
//
// Usage:
//   <ModelPanelList models={gameState.models} metricMax={100} />
// ============================================================================

import type { ModelState } from '@/lib/types';
import ModelPanel from './ModelPanel';
import styles from './ModelPanelList.module.scss';

interface ModelPanelListProps {
  models: ModelState[];
  metricMax: number;
}

export default function ModelPanelList({ models, metricMax }: ModelPanelListProps) {
  return (
    <aside className={styles.sidebar}>
      {models.map((model) => (
        <ModelPanel key={model.id} model={model} metricMax={metricMax} />
      ))}
    </aside>
  );
}
