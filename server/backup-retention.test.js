// node --test server/backup-retention.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBackupName, normalizeRetentionPolicy, parseStoredRetentionPolicy, selectBackupsToDelete, periodKey } = require('./backup-retention');

const stamp = date => new Date(date).toISOString().replace(/[:.]/g, '-');
const automated = date => `backup-${stamp(date)}.sqlite`;
const manual = date => `backup-${stamp(date)}-manual.sqlite`;
const full = date => `backup-${stamp(date)}-0a1b2c3d-full.zip`;
const daysAgo = (now, days) => new Date(now.getTime() - days * 86400000);

test('parses the three backup kinds and ignores everything else', () => {
  assert.equal(parseBackupName(automated('2026-11-23T03:00:00.123Z')).kind, 'automated');
  assert.equal(parseBackupName(manual('2026-11-23T03:00:00.123Z')).kind, 'manual');
  assert.equal(parseBackupName(full('2026-11-23T03:00:00.123Z')).kind, 'full');
  assert.equal(parseBackupName(automated('2026-11-23T03:00:00.123Z')).createdAt.toISOString(), '2026-11-23T03:00:00.123Z');
  for (const name of ['kept.sqlite', 'backup-notes.sqlite', '.restore-abc', 'backup-2026-11-23T03-00-00-123Z.sqlite.tmp', '../backup-2026-11-23T03-00-00-123Z.sqlite']) {
    assert.equal(parseBackupName(name), null, name);
  }
});

test('ISO week keys handle year boundaries', () => {
  assert.equal(periodKey(new Date('2026-01-01T12:00:00Z'), 'week'), '2026-W01');
  assert.equal(periodKey(new Date('2027-01-01T12:00:00Z'), 'week'), '2026-W53');
  assert.equal(periodKey(new Date('2024-12-30T12:00:00Z'), 'week'), '2025-W01');
  assert.equal(periodKey(new Date('2026-11-23T12:00:00Z'), 'week'), '2026-W48');
});

test('policies are validated; stored garbage falls back to keeping everything', () => {
  assert.deepEqual(normalizeRetentionPolicy(undefined), { mode: 'all', includeManual: false });
  assert.deepEqual(normalizeRetentionPolicy({ mode: 'count', keepLast: '7' }), { mode: 'count', keepLast: 7, includeManual: false });
  assert.deepEqual(normalizeRetentionPolicy({ mode: 'smart', daily: 7, weekly: 4, includeManual: true }),
    { mode: 'smart', includeManual: true, daily: 7, weekly: 4, monthly: 0, yearly: 0 });
  for (const bad of [{ mode: 'count', keepLast: 0 }, { mode: 'count', keepLast: 1.5 }, { mode: 'age', maxAgeDays: -1 },
    { mode: 'smart', daily: 0, weekly: 0, monthly: 0, yearly: 0 }, { mode: 'nope' }, [], 'all']) {
    assert.throws(() => normalizeRetentionPolicy(bad), { status: 400 }, JSON.stringify(bad));
  }
  assert.deepEqual(parseStoredRetentionPolicy('{not json'), { mode: 'all', includeManual: false });
  assert.deepEqual(parseStoredRetentionPolicy(JSON.stringify({ mode: 'count', keepLast: 99999 })), { mode: 'all', includeManual: false });
});

test('keep all deletes nothing', () => {
  const now = new Date('2026-11-23T04:00:00Z');
  const names = Array.from({ length: 30 }, (_, i) => automated(daysAgo(now, i)));
  assert.deepEqual(selectBackupsToDelete(names, { mode: 'all' }, now), []);
});

test('count keeps the newest N scheduled backups', () => {
  const now = new Date('2026-11-23T04:00:00Z');
  const names = Array.from({ length: 10 }, (_, i) => automated(daysAgo(now, i)));
  const deleted = selectBackupsToDelete(names, { mode: 'count', keepLast: 3 }, now);
  assert.deepEqual(deleted.sort(), names.slice(3).sort());
});

test('age deletes old backups but always keeps the newest one', () => {
  const now = new Date('2026-11-23T04:00:00Z');
  const names = [0, 5, 29, 31, 90].map(days => automated(daysAgo(now, days)));
  assert.deepEqual(selectBackupsToDelete(names, { mode: 'age', maxAgeDays: 30 }, now).sort(), [names[3], names[4]].sort());
  // Scheduling stopped long ago: the last remaining backup survives.
  const stale = [100, 200].map(days => automated(daysAgo(now, days)));
  assert.deepEqual(selectBackupsToDelete(stale, { mode: 'age', maxAgeDays: 30 }, now), [stale[1]]);
});

test('smart keeps one backup per day, week, month and year', () => {
  const now = new Date('2026-11-23T04:00:00Z');
  // A year and a half of daily backups at 03:00, plus a second backup today.
  const names = Array.from({ length: 540 }, (_, i) => automated(new Date(daysAgo(now, i).setUTCHours(3, 0, 0, 0))));
  names.push(automated('2026-11-23T03:30:00.000Z'));
  const policy = { mode: 'smart', daily: 7, weekly: 4, monthly: 6, yearly: 2 };
  const deleted = new Set(selectBackupsToDelete(names, policy, now));
  const kept = names.filter(name => !deleted.has(name)).map(name => parseBackupName(name).createdAt.toISOString()).sort().reverse();
  // Today's newest copy wins the day; the earlier one today is dropped.
  assert.equal(kept[0], '2026-11-23T03:30:00.000Z');
  assert.ok(deleted.has(automated('2026-11-23T03:00:00.000Z')));
  // 7 daily keeps are the last 7 days.
  for (let i = 1; i < 7; i++) assert.ok(!deleted.has(automated(new Date(daysAgo(now, i).setUTCHours(3, 0, 0, 0)))), `day ${i}`);
  const keptDays = new Set(kept.map(iso => iso.slice(0, 10)));
  assert.ok(keptDays.size >= 7 && keptDays.size <= 7 + 4 + 6 + 2, `kept ${keptDays.size} days`);
  // Monthly keeps reach back six months; yearly keeps reach into 2025.
  assert.ok(kept.some(iso => iso.startsWith('2026-06')));
  assert.ok(kept.some(iso => iso.startsWith('2025-')));
  assert.ok(kept.length < 25);
});

test('manual and full backups are untouched unless included, and pruned as separate groups', () => {
  const now = new Date('2026-11-23T04:00:00Z');
  const names = [
    ...[0, 1, 2].map(days => automated(daysAgo(now, days))),
    ...[0, 3, 6].map(days => manual(daysAgo(now, days))),
    ...[10, 40].map(days => full(daysAgo(now, days)))
  ];
  const policy = { mode: 'count', keepLast: 1 };
  assert.deepEqual(selectBackupsToDelete(names, policy, now).sort(), names.slice(1, 3).sort());
  const all = selectBackupsToDelete(names, { ...policy, includeManual: true }, now).sort();
  // Newest of each group survives: the full ZIP is kept even though newer
  // manual database copies exist.
  assert.deepEqual(all, [names[1], names[2], names[4], names[5], names[7]].sort());
});
