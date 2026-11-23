'use strict';

// Backup retention (issue #171). Pure functions: the server lists the backup
// directory, asks which files a policy no longer keeps, and deletes those.
//
// Policies:
//   { mode: 'all' }                                  keep everything (default)
//   { mode: 'count', keepLast: N }                   keep the newest N
//   { mode: 'age', maxAgeDays: N }                   delete backups older than N days
//   { mode: 'smart', daily, weekly, monthly, yearly } keep the newest backup of
//       each of the last `daily` days, `weekly` ISO weeks, `monthly` months and
//       `yearly` years that have one (grandfather-father-son, like Duplicacy,
//       restic or borg "keep-daily/weekly/...")
// plus `includeManual`: also prune manual and full backups (as their own
// group, so a full ZIP is never deleted to make room for a database copy).
//
// Whatever the policy, the newest backup in each group is always kept.

const DEFAULT_POLICY = Object.freeze({ mode: 'all', includeManual: false });
const LIMITS = { keepLast: [1, 1000], maxAgeDays: [1, 3650], daily: [0, 366], weekly: [0, 520], monthly: [0, 240], yearly: [0, 100] };
const DAY_MS = 24 * 60 * 60 * 1000;

// backup-2026-11-23T03-00-00-123Z.sqlite            automated (scheduled)
// backup-2026-11-23T03-00-00-123Z-manual.sqlite     manual database copy
// backup-2026-11-23T03-00-00-123Z-1a2b3c4d-full.zip full server backup
const NAME = /^backup-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:(-manual)\.sqlite|-[0-9a-f]+-full\.zip|\.sqlite)$/;

function parseBackupName(name) {
  const match = NAME.exec(String(name || ''));
  if (!match) return null;
  const [, date, hours, minutes, seconds, millis, manual] = match;
  const createdAt = new Date(`${date}T${hours}:${minutes}:${seconds}.${millis}Z`);
  if (Number.isNaN(createdAt.getTime())) return null;
  const kind = name.endsWith('-full.zip') ? 'full' : manual ? 'manual' : 'automated';
  return { name, createdAt, kind };
}

function integerIn(value, [min, max], field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw Object.assign(new Error(`${field} must be a whole number from ${min} to ${max}.`), { status: 400 });
  }
  return number;
}

// Validates untrusted input and returns a clean policy object.
function normalizeRetentionPolicy(input) {
  if (input === undefined || input === null || input === '') return { ...DEFAULT_POLICY };
  if (typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('Invalid retention policy.'), { status: 400 });
  const includeManual = input.includeManual === true;
  switch (input.mode) {
    case 'all':
    case undefined:
      return { mode: 'all', includeManual };
    case 'count':
      return { mode: 'count', keepLast: integerIn(input.keepLast, LIMITS.keepLast, 'keepLast'), includeManual };
    case 'age':
      return { mode: 'age', maxAgeDays: integerIn(input.maxAgeDays, LIMITS.maxAgeDays, 'maxAgeDays'), includeManual };
    case 'smart': {
      const policy = { mode: 'smart', includeManual };
      for (const field of ['daily', 'weekly', 'monthly', 'yearly']) policy[field] = integerIn(input[field] ?? 0, LIMITS[field], field);
      if (!policy.daily && !policy.weekly && !policy.monthly && !policy.yearly) {
        throw Object.assign(new Error('Keep at least one daily, weekly, monthly or yearly backup.'), { status: 400 });
      }
      return policy;
    }
    default:
      throw Object.assign(new Error('Invalid retention mode.'), { status: 400 });
  }
}

// Reads a stored policy; anything unreadable falls back to keeping everything.
function parseStoredRetentionPolicy(raw) {
  try { return normalizeRetentionPolicy(raw ? JSON.parse(raw) : undefined); } catch { return { ...DEFAULT_POLICY }; }
}

// Calendar periods use UTC, matching the UTC timestamps in backup names.
function periodKey(date, period) {
  const year = date.getUTCFullYear();
  if (period === 'year') return String(year);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  if (period === 'month') return `${year}-${month}`;
  if (period === 'day') return `${year}-${month}-${String(date.getUTCDate()).padStart(2, '0')}`;
  // ISO-8601 week: the week belongs to the year of its Thursday.
  const thursday = new Date(Date.UTC(year, date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday - firstThursday) / DAY_MS - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// `backups` are parsed entries of one group. Returns the names to delete.
function selectGroupForDeletion(backups, policy, now) {
  const newestFirst = [...backups].sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1));
  if (newestFirst.length <= 1 || policy.mode === 'all') return [];
  const keep = new Set([newestFirst[0].name]);
  if (policy.mode === 'count') {
    for (const backup of newestFirst.slice(0, policy.keepLast)) keep.add(backup.name);
  } else if (policy.mode === 'age') {
    const cutoff = now.getTime() - policy.maxAgeDays * DAY_MS;
    for (const backup of newestFirst) if (backup.createdAt.getTime() >= cutoff) keep.add(backup.name);
  } else if (policy.mode === 'smart') {
    for (const [period, slots] of [['day', policy.daily], ['week', policy.weekly], ['month', policy.monthly], ['year', policy.yearly]]) {
      const seen = new Set();
      for (const backup of newestFirst) {
        if (seen.size >= slots) break;
        const key = periodKey(backup.createdAt, period);
        if (seen.has(key)) continue;
        seen.add(key);
        keep.add(backup.name); // newest backup of this period
      }
    }
  }
  return newestFirst.filter(backup => !keep.has(backup.name)).map(backup => backup.name);
}

// Returns the file names in `names` that `policy` no longer keeps. Files that
// don't look like Kept backups are never selected.
function selectBackupsToDelete(names, policy, now = new Date()) {
  const clean = normalizeRetentionPolicy(policy);
  if (clean.mode === 'all') return [];
  const parsed = names.map(parseBackupName).filter(Boolean);
  const automated = parsed.filter(backup => backup.kind === 'automated');
  const deletions = selectGroupForDeletion(automated, clean, now);
  if (clean.includeManual) {
    deletions.push(...selectGroupForDeletion(parsed.filter(backup => backup.kind === 'manual'), clean, now));
    deletions.push(...selectGroupForDeletion(parsed.filter(backup => backup.kind === 'full'), clean, now));
  }
  return deletions;
}

module.exports = { DEFAULT_POLICY, parseBackupName, normalizeRetentionPolicy, parseStoredRetentionPolicy, selectBackupsToDelete, periodKey };
