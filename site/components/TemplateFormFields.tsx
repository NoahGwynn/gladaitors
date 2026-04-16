// ============================================================================
// TemplateFormFields — renders a debate template's per-field inputs
// ============================================================================
// v3 utility pivot Phase B. Each template carries a `formFields` schema
// describing the inputs it wants. This component walks the schema and
// renders the right input per field kind (textarea, urlList,
// candidateList). Values are stored as a single `Record<id, value>` on
// the parent so the page can serialise them into the debate context
// on submit.
//
// URL/upload fields are gated behind login — logged-out users see a
// sign-in nudge instead of the input. The decision lives here rather
// than per-field so adding new gated kinds (file upload, etc.) is a
// one-line change.
// ============================================================================

'use client';

import { Plus, X } from 'lucide-react';
import type {
  DebateTemplate,
  TemplateFormField,
  TemplateFieldValues,
  CandidateValue,
} from '@/lib/debate-templates';
import styles from './TemplateFormFields.module.scss';

interface Props {
  template: DebateTemplate;
  values: TemplateFieldValues;
  onChange: (values: TemplateFieldValues) => void;
  isLoggedIn: boolean;
  onLoginRequired: () => void;
  disabled?: boolean;
}

export default function TemplateFormFields({
  template,
  values,
  onChange,
  isLoggedIn,
  onLoginRequired,
  disabled,
}: Props) {
  function setFieldValue(id: string, next: unknown) {
    onChange({ ...values, [id]: next as TemplateFieldValues[string] });
  }

  return (
    <div className={styles.fields}>
      {template.formFields.map((field) => (
        <FieldRenderer
          key={field.id}
          field={field}
          value={values[field.id]}
          onChange={(next) => setFieldValue(field.id, next)}
          isLoggedIn={isLoggedIn}
          onLoginRequired={onLoginRequired}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

interface FieldRendererProps {
  field: TemplateFormField;
  value: TemplateFieldValues[string] | undefined;
  onChange: (next: unknown) => void;
  isLoggedIn: boolean;
  onLoginRequired: () => void;
  disabled?: boolean;
}

function FieldRenderer({
  field,
  value,
  onChange,
  isLoggedIn,
  onLoginRequired,
  disabled,
}: FieldRendererProps) {
  // Login gate — collapse the field to a sign-in nudge for guests so
  // they can see the affordance exists without it being functional.
  if (field.loggedInOnly && !isLoggedIn) {
    return (
      <div className={styles.field}>
        <label className={styles.label}>
          {field.label}
          <span className={styles.lockedBadge}>Sign in required</span>
        </label>
        {field.hint && <p className={styles.hint}>{field.hint}</p>}
        <button
          type="button"
          className={styles.loginNudge}
          onClick={onLoginRequired}
        >
          Sign in to add {field.kind === 'urlList' ? 'links' : 'this'}
        </button>
      </div>
    );
  }

  if (field.kind === 'textarea') {
    const text = typeof value === 'string' ? value : '';
    return (
      <div className={styles.field}>
        <label className={styles.label}>
          {field.label}
          {field.required && <span className={styles.required}>*</span>}
        </label>
        {field.hint && <p className={styles.hint}>{field.hint}</p>}
        <textarea
          className={styles.textarea}
          value={text}
          placeholder={field.placeholder}
          maxLength={field.max}
          rows={field.rows ?? 4}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
      </div>
    );
  }

  if (field.kind === 'urlList') {
    const max = field.max;
    const placeholder = field.placeholder;
    const urls = Array.isArray(value) ? (value as string[]) : [''];
    function update(idx: number, next: string) {
      const updated = [...urls];
      updated[idx] = next;
      onChange(updated);
    }
    function add() {
      if (urls.length >= max) return;
      onChange([...urls, '']);
    }
    function remove(idx: number) {
      if (urls.length === 1) {
        onChange(['']);
        return;
      }
      onChange(urls.filter((_, i) => i !== idx));
    }
    return (
      <div className={styles.field}>
        <label className={styles.label}>{field.label}</label>
        {field.hint && <p className={styles.hint}>{field.hint}</p>}
        <div className={styles.urlList}>
          {urls.map((url, i) => (
            <div key={i} className={styles.urlRow}>
              <input
                type="url"
                className={styles.input}
                value={url}
                placeholder={placeholder ?? 'https://...'}
                onChange={(e) => update(i, e.target.value)}
                disabled={disabled}
              />
              {urls.length > 1 && (
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={() => remove(i)}
                  aria-label="Remove URL"
                  disabled={disabled}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
          {urls.length < max && (
            <button
              type="button"
              className={styles.addButton}
              onClick={add}
              disabled={disabled}
            >
              <Plus size={14} /> Add URL
            </button>
          )}
        </div>
      </div>
    );
  }

  if (field.kind === 'candidateList') {
    const min = field.minCandidates ?? 2;
    const max = field.maxCandidates ?? 6;
    const candidates = Array.isArray(value)
      ? (value as CandidateValue[])
      : Array.from({ length: min }, () => ({ name: '', summary: '', url: '' }));
    function update(idx: number, patch: Partial<CandidateValue>) {
      const updated = [...candidates];
      updated[idx] = { ...updated[idx], ...patch };
      onChange(updated);
    }
    function add() {
      if (candidates.length >= max) return;
      onChange([...candidates, { name: '', summary: '', url: '' }]);
    }
    function remove(idx: number) {
      if (candidates.length <= min) return;
      onChange(candidates.filter((_, i) => i !== idx));
    }
    return (
      <div className={styles.field}>
        <label className={styles.label}>
          {field.label}
          {field.required && <span className={styles.required}>*</span>}
        </label>
        {field.hint && <p className={styles.hint}>{field.hint}</p>}
        <div className={styles.candidateList}>
          {candidates.map((candidate, i) => (
            <div key={i} className={styles.candidateCard}>
              <div className={styles.candidateHeader}>
                <span className={styles.candidateLabel}>Candidate {i + 1}</span>
                {candidates.length > min && (
                  <button
                    type="button"
                    className={styles.removeButton}
                    onClick={() => remove(i)}
                    aria-label="Remove candidate"
                    disabled={disabled}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <input
                className={styles.input}
                type="text"
                value={candidate.name}
                placeholder="Name or alias (e.g. Alex, Candidate A)"
                onChange={(e) => update(i, { name: e.target.value })}
                disabled={disabled}
                maxLength={120}
              />
              <textarea
                className={styles.textarea}
                value={candidate.summary}
                placeholder="Short summary — strengths, gaps, why they're in the running"
                onChange={(e) => update(i, { summary: e.target.value })}
                disabled={disabled}
                rows={3}
                maxLength={1500}
              />
              {isLoggedIn ? (
                <input
                  className={styles.input}
                  type="url"
                  value={candidate.url}
                  placeholder="Optional URL (CV, LinkedIn, portfolio)"
                  onChange={(e) => update(i, { url: e.target.value })}
                  disabled={disabled}
                />
              ) : (
                <button
                  type="button"
                  className={styles.loginNudgeInline}
                  onClick={onLoginRequired}
                >
                  Sign in to add a CV / portfolio link
                </button>
              )}
            </div>
          ))}
          {candidates.length < max && (
            <button
              type="button"
              className={styles.addButton}
              onClick={add}
              disabled={disabled}
            >
              <Plus size={14} /> Add candidate
            </button>
          )}
        </div>
      </div>
    );
  }

  return null;
}
