import type { OfflineSyncState } from '../services/offline-sync.service';

export function describeSyncStatus(state: OfflineSyncState, pending: number, lastSyncedAt: number | null, storageBlocked: boolean, manualSyncing = false) {
  // Explicit retries get progress feedback, but an outage remains offline
  // until the server actually responds successfully.
  if (manualSyncing && state !== 'offline' && !storageBlocked) state = 'syncing';
  const time = lastSyncedAt === null ? '' : new Date(lastSyncedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const lastGood = time ? `Last synced ${time}` : 'Not synced yet';
  const changes = `${pending} ${pending === 1 ? 'change' : 'changes'}`;
  const attention = storageBlocked || state === 'error' || (pending > 0 && state !== 'syncing');
  const syncing = state === 'syncing' && !storageBlocked;
  let label: string;
  let detail = '';
  let icon = 'cloud_done';
  if (storageBlocked) {
    label = pending ? `Storage full · ${pending} waiting` : 'Storage full';
    detail = lastGood;
    icon = 'storage';
  } else if (state === 'offline') {
    label = pending ? `${changes} waiting` : 'Offline';
    detail = pending ? `Offline · ${lastGood.charAt(0).toLowerCase() + lastGood.slice(1)}` : lastGood;
    icon = 'cloud_off';
  } else if (state === 'error') {
    label = pending ? `Couldn't sync · ${pending} waiting` : "Couldn't sync";
    detail = lastGood;
    icon = 'sync_problem';
  } else if (syncing) {
    label = pending ? `Syncing ${changes}…` : 'Syncing…';
    icon = 'sync';
  } else if (pending) {
    label = `${changes} waiting`;
    detail = lastGood;
    icon = 'cloud_upload';
  } else {
    label = time ? `Synced ${time}` : lastGood;
  }
  return { label, detail, icon, attention, syncing,
    action: attention || state === 'offline' ? 'Retry' : 'Sync now',
    disabled: manualSyncing || state === 'syncing' };
}
