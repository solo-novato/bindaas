import { api } from './api';
import type { AccountStatus } from './types';

// Shared by the overview and bottom bar in this window. Rust serializes and
// persists observations across every project window.
export const accountUsage = $state({
  value: null as AccountStatus | null,
  loading: false,
  error: '',
  stale: false,
});
let revision = 0;
let pending: Promise<void> | null = null;
export function invalidateAccountUsage() {
  revision++;
  accountUsage.value = null;
  accountUsage.error = '';
  accountUsage.stale = true;
}
export function refreshAccountUsage(): Promise<void> {
  if (pending) return pending;
  const started = revision;
  accountUsage.loading = true;
  pending = (async () => {
    try {
      const value = await api.accountStatus('codex');
      if (started !== revision) return;
      accountUsage.value = value;
      accountUsage.error = '';
      accountUsage.stale = false;
    } catch (error) {
      if (started !== revision) return;
      accountUsage.error = String(error);
      accountUsage.stale = true;
    } finally {
      accountUsage.loading = false;
      pending = null;
    }
  })();
  return pending;
}
