// ============================================================================
// Debate Arena — /arena/debate
// ============================================================================
// Users configure a debate topic, assign positions to AI models,
// and watch them argue. Output is stored and shareable.
// ============================================================================

'use client';

import { useState } from 'react';
import { config } from '@/lib/config';
import type { DebateArgument } from '@/lib/types';
import styles from './page.module.scss';

const MODEL_COLOURS: Record<string, string> = {
  claude: '#7C3AED',
  gpt4o: '#10B981',
  gemini: '#3B82F6',
};

interface DebaterConfig {
  modelId: string;
  position: string;
}

export default function DebateArenaPage() {
  const [topic, setTopic] = useState('');
  const [debaters, setDebaters] = useState<DebaterConfig[]>([
    { modelId: 'claude', position: '' },
    { modelId: 'gpt4o', position: '' },
  ]);
  const [rounds, setRounds] = useState(5);
  const [context, setContext] = useState('');
  const [generating, setGenerating] = useState(false);
  const [arguments_, setArguments] = useState<DebateArgument[]>([]);
  const [error, setError] = useState<string | null>(null);

  const cost = config.debateCost[rounds] || 10;
  const canAddModel = debaters.length < 3;
  const usedModels = new Set(debaters.map(d => d.modelId));
  const availableModels = config.debateModels.filter(m => !usedModels.has(m.id));

  const isValid = topic.trim().length > 0 &&
    debaters.every(d => d.position.trim().length > 0) &&
    debaters.length >= 2;

  function updateDebater(index: number, field: keyof DebaterConfig, value: string) {
    setDebaters(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  }

  function addDebater() {
    if (!canAddModel || availableModels.length === 0) return;
    setDebaters(prev => [...prev, { modelId: availableModels[0].id, position: '' }]);
  }

  function removeDebater(index: number) {
    if (debaters.length <= 2) return;
    setDebaters(prev => prev.filter((_, i) => i !== index));
  }

  async function generateDebate() {
    if (!isValid || generating) return;
    setGenerating(true);
    setArguments([]);
    setError(null);

    try {
      const res = await fetch('/api/debate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic,
          debaters,
          rounds,
          context: context || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to generate debate');
      }

      const data = await res.json();
      setArguments(data.arguments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setGenerating(false);
    }
  }

  function getModelName(modelId: string): string {
    return config.debateModels.find(m => m.id === modelId)?.name || modelId;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>The Arena</h1>
        <p className={styles.subtitle}>
          Set the topic. Assign the positions. Watch AI models debate.
        </p>
      </header>

      {/* Debate form */}
      <div className={styles.form}>
        <div className={styles.field}>
          <label className={styles.label}>Topic</label>
          <input
            className={styles.input}
            type="text"
            placeholder="e.g. Is a banana a berry?"
            maxLength={config.maxTopicLength}
            value={topic}
            onChange={e => setTopic(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Assign positions</label>
          <div className={styles.positions}>
            {debaters.map((debater, i) => (
              <div key={i} className={styles.positionRow}>
                <div
                  className={styles.modelDot}
                  style={{ background: MODEL_COLOURS[debater.modelId] || '#888' }}
                />
                <select
                  className={styles.modelSelect}
                  value={debater.modelId}
                  onChange={e => updateDebater(i, 'modelId', e.target.value)}
                >
                  {config.debateModels.map(m => (
                    <option key={m.id} value={m.id} disabled={usedModels.has(m.id) && m.id !== debater.modelId}>
                      {m.name}
                    </option>
                  ))}
                </select>
                <input
                  className={styles.positionInput}
                  type="text"
                  placeholder={`argues: ...`}
                  maxLength={config.maxPositionLength}
                  value={debater.position}
                  onChange={e => updateDebater(i, 'position', e.target.value)}
                />
                {debaters.length > 2 && (
                  <button className={styles.removeButton} onClick={() => removeDebater(i)}>
                    ✕
                  </button>
                )}
              </div>
            ))}
            {canAddModel && availableModels.length > 0 && (
              <button className={styles.addModel} onClick={addDebater}>
                + Add model
              </button>
            )}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Rounds</label>
          <div className={styles.roundSelector}>
            {[3, 5, 7].map(n => (
              <button
                key={n}
                className={`${styles.roundOption} ${rounds === n ? styles.roundOptionActive : ''}`}
                onClick={() => setRounds(n)}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Context or rules (optional)</label>
          <textarea
            className={styles.textarea}
            placeholder="e.g. Keep arguments to scientific evidence only"
            maxLength={config.maxContextLength}
            value={context}
            onChange={e => setContext(e.target.value)}
          />
        </div>

        <div className={styles.submitRow}>
          <span className={styles.cost}>{cost} tokens</span>
          <button
            className={styles.submitButton}
            disabled={!isValid || generating}
            onClick={generateDebate}
          >
            {generating ? 'Generating...' : 'Generate Debate'}
          </button>
        </div>

        {error && <p style={{ color: '#EF4444' }}>{error}</p>}
      </div>

      {/* Generating state */}
      {generating && (
        <div className={styles.generating}>
          <span className={styles.spinner} />
          Models are debating...
        </div>
      )}

      {/* Debate output */}
      {arguments_.length > 0 && (
        <div className={styles.debateContainer}>
          {Array.from(new Set(arguments_.map(a => a.round))).map(roundNum => (
            <div key={roundNum}>
              <div className={styles.roundLabel}>
                {roundNum === 1 ? 'Opening Statements' :
                 roundNum === rounds ? 'Closing Statements' :
                 `Round ${roundNum}`}
              </div>
              {arguments_.filter(a => a.round === roundNum).map((arg, i) => (
                <div
                  key={`${roundNum}-${i}`}
                  className={styles.argument}
                  style={{ '--model-colour': MODEL_COLOURS[arg.model_id] || '#888' } as React.CSSProperties}
                >
                  <div className={styles.argumentHeader}>
                    <span className={styles.argumentModel}>{arg.model_name}</span>
                    <span className={styles.argumentPosition}>
                      {debaters.find(d => d.modelId === arg.model_id)?.position}
                    </span>
                  </div>
                  {arg.refused ? (
                    <p className={styles.refusal}>
                      Declined this position{arg.refusal_reason ? `: ${arg.refusal_reason}` : ''}
                    </p>
                  ) : (
                    <div className={styles.argumentContent}>{arg.content}</div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
