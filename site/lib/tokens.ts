// ============================================================================
// Token balance — shared fetch + sync across components
// ============================================================================

import { getSessionId } from './debates';

/** Fetch the current token balance from the server */
export async function fetchTokenBalance(): Promise<number> {
  const sessionId = getSessionId();
  const res = await fetch('/api/tokens', {
    headers: sessionId ? { 'x-session-id': sessionId } : {},
  });
  if (!res.ok) return 0;
  const { balance } = await res.json();
  return balance ?? 0;
}

/** Notify all listeners that the balance has changed */
export function notifyBalanceChanged() {
  window.dispatchEvent(new Event('token-balance-changed'));
}

/** Subscribe to balance changes — returns cleanup function */
export function onBalanceChanged(callback: () => void): () => void {
  window.addEventListener('token-balance-changed', callback);
  return () => window.removeEventListener('token-balance-changed', callback);
}
