import { uiText, uiPlural, uiLocale } from '../i18n/messages';
import type { OfflineSyncState } from '../services/offline-sync.service';

export function describeSyncStatus(state: OfflineSyncState, pending: number, lastSyncedAt: number | null, storageBlocked: boolean, manualSyncing = false) {
  // Explicit retries get progress feedback, but an outage remains offline
  // until the server actually responds successfully.
  if (manualSyncing && state !== 'offline' && !storageBlocked) state = 'syncing';
  const time = lastSyncedAt === null ? '' : new Date(lastSyncedAt).toLocaleTimeString(uiLocale(), { hour: 'numeric', minute: '2-digit' });
  const lastGood = time ? uiText('sync.last_synced', { time }) : uiText('sync.not_yet');
  const attention = storageBlocked || state === 'error' || (pending > 0 && state !== 'syncing');
  const syncing = state === 'syncing' && !storageBlocked;
  let label: string;
  let detail = '';
  let icon = 'cloud_done';
  if (storageBlocked) {
    label = pending ? uiText('sync.storage_waiting', { count: pending }) : uiText('sync.storage_full');
    detail = lastGood;
    icon = 'storage';
  } else if (state === 'offline') {
    label = pending ? uiPlural('sync.waiting', pending) : uiText('sync.offline');
    detail = pending ? (time ? uiText('sync.offline_last', { time }) : uiText('sync.offline_not_yet')) : lastGood;
    icon = 'cloud_off';
  } else if (state === 'error') {
    label = pending ? uiText('sync.error_waiting', { count: pending }) : uiText('sync.error');
    detail = lastGood;
    icon = 'sync_problem';
  } else if (syncing) {
    label = pending ? uiPlural('sync.syncing', pending) : uiText('sync.syncing');
    icon = 'sync';
  } else if (pending) {
    label = uiPlural('sync.waiting', pending);
    detail = lastGood;
    icon = 'cloud_upload';
  } else {
    label = time ? uiText('sync.synced', { time }) : lastGood;
  }
  return { label, detail, icon, attention, syncing,
    action: attention || state === 'offline' ? uiText('common.retry') : uiText('common.sync_now'),
    disabled: manualSyncing || state === 'syncing' };
}
