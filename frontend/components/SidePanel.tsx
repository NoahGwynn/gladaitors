// ============================================================================
// SidePanel — right panel with compact model cards + scrolling action feed
// ============================================================================

import type { ModelState } from '@/lib/types';
import ModelCardStrip from './ModelCardStrip';
import ActionFeed, { type ActionEntry } from './ActionFeed';
import styles from './SidePanel.module.scss';

interface SidePanelProps {
  models: ModelState[];
  actionHistory: ActionEntry[];
}

export default function SidePanel({ models, actionHistory }: SidePanelProps) {
  return (
    <aside className={styles.sidebar}>
      <ModelCardStrip models={models} />
      <ActionFeed entries={actionHistory} />
    </aside>
  );
}
