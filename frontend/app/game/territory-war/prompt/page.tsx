// ============================================================================
// Prompt Viewer — /game/territory-war/prompt
// ============================================================================
// Displays the prompt templates sent to AI models for Territory War.
// Fetches directly from the backend's prompt template files via API,
// so this page always reflects the current source of truth.
// ============================================================================

'use client';

import { useEffect, useState } from 'react';
import styles from './page.module.scss';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface PromptData {
  system_template?: string;
  turn_template?: string;
  template?: string;
}

export default function TerritoryWarPromptPage() {
  const [data, setData] = useState<PromptData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/prompts/territory_war`)
      .then(res => res.json())
      .then(result => {
        if (result.system_template || result.template) {
          setData(result);
        } else {
          setError(result.message || 'Failed to load prompt template');
        }
      })
      .catch(err => setError(`Cannot connect to backend: ${err.message}`));
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Territory War — Prompt Templates</h1>
        <p className={styles.subtitle}>
          These are the exact templates sent to each AI model.
          Variables in <span className={styles.variable}>{'{braces}'}</span> are
          replaced with live game state. The system prompt is sent once and
          cached; the turn prompt is sent fresh each turn with current state.
        </p>
      </header>

      <div className={styles.content}>
        {error && <p className={styles.error}>{error}</p>}

        {data?.system_template && (
          <>
            <h2 className={styles.sectionTitle}>System Prompt (rules — cached)</h2>
            <pre className={styles.template}>{data.system_template}</pre>
          </>
        )}

        {data?.turn_template && (
          <>
            <h2 className={styles.sectionTitle}>Turn Prompt (state — sent each turn)</h2>
            <pre className={styles.template}>{data.turn_template}</pre>
          </>
        )}

        {data?.template && !data.system_template && (
          <>
            <h2 className={styles.sectionTitle}>Prompt Template</h2>
            <pre className={styles.template}>{data.template}</pre>
          </>
        )}

        {!data && !error && <p className={styles.loading}>Loading...</p>}
      </div>
    </div>
  );
}
