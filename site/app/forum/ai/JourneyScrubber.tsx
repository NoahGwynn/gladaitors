// ============================================================================
// JourneyScrubber — horizontal 6-stage visual timeline
// ============================================================================
// The hero element of the session page. 6 numbered segments representing
// the stages a session goes through. Click any to expand the detail
// panel below.
//
// Visual states per segment:
//   - future       dim outline, clickable (shows explainer only)
//   - active       pulsing fill, current work in progress
//   - completed    solid fill, clickable (shows full detail)
//   - failed       red outline (if a failure happened in that stage)
//
// Layout is horizontal on desktop, scrollable or stacked on mobile.
// ============================================================================

'use client';

import styles from './page.module.scss';
import { SCRUBBER_STAGES, type ScrubberStage } from '@/lib/forum/scrubber-stages';

interface JourneyScrubberProps {
  /** 1-based number of the currently-active stage. 0 = not started. */
  currentStage: number;
  /** How many stages have been completed so far (0-6). */
  completedCount: number;
  /** Which stage is currently selected/expanded in the detail panel. null = none */
  selectedStage: number | null;
  /** Called when a user clicks a stage dot. Pass null to close. */
  onSelect: (stage: number | null) => void;
}

export default function JourneyScrubber({
  currentStage,
  completedCount,
  selectedStage,
  onSelect,
}: JourneyScrubberProps) {
  return (
    <div className={styles.scrubber}>
      <div className={styles.scrubberTrack}>
        {SCRUBBER_STAGES.map((stage, idx) => {
          const state = getStageState(stage, currentStage, completedCount);
          const isSelected = selectedStage === stage.num;
          const isLast = idx === SCRUBBER_STAGES.length - 1;
          return (
            <ScrubberStep
              key={stage.num}
              stage={stage}
              state={state}
              isSelected={isSelected}
              isLast={isLast}
              onClick={() => onSelect(isSelected ? null : stage.num)}
            />
          );
        })}
      </div>
    </div>
  );
}

// --- Types ---

type StageState = 'future' | 'active' | 'completed';

function getStageState(
  stage: ScrubberStage,
  currentStage: number,
  completedCount: number,
): StageState {
  if (stage.num <= completedCount) return 'completed';
  if (stage.num === currentStage) return 'active';
  return 'future';
}

// --- Single step ---

interface ScrubberStepProps {
  stage: ScrubberStage;
  state: StageState;
  isSelected: boolean;
  isLast: boolean;
  onClick: () => void;
}

function ScrubberStep({ stage, state, isSelected, isLast, onClick }: ScrubberStepProps) {
  const stepClass = [
    styles.scrubberStep,
    styles[`scrubberStep_${state}`],
    isSelected ? styles.scrubberStep_selected : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <button type="button" className={stepClass} onClick={onClick} aria-label={stage.fullTitle}>
        <span className={styles.scrubberDot}>{stage.num}</span>
        <span className={styles.scrubberLabel}>{stage.shortTitle}</span>
      </button>
      {!isLast && <div className={`${styles.scrubberConnector} ${state !== 'future' ? styles.scrubberConnector_filled : ''}`} />}
    </>
  );
}
