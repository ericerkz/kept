const formatters = new Map();

function partsAt(epochMs, timezone) {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

function localScalar(parts, milliseconds = 0) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, milliseconds);
}

// Resolve wall-clock time like java.time.ZonedDateTime: move forward through
// a DST gap and choose the earlier instant when a wall time occurs twice.
function instantAt(parts, milliseconds, timezone) {
  const target = localScalar(parts, milliseconds);
  const offsets = new Set();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = target + hours * 60 * 60 * 1000;
    offsets.add(localScalar(partsAt(sample, timezone), new Date(sample).getUTCMilliseconds()) - sample);
  }
  const candidates = [...offsets].map(offset => target - offset).map(epochMs => ({
    epochMs, wall: localScalar(partsAt(epochMs, timezone), new Date(epochMs).getUTCMilliseconds())
  }));
  const exact = candidates.filter(candidate => candidate.wall === target).sort((a, b) => a.epochMs - b.epochMs);
  if (exact.length) return new Date(exact[0].epochMs);
  const afterGap = candidates.filter(candidate => candidate.wall > target).sort((a, b) => a.wall - b.wall || a.epochMs - b.epochMs);
  if (afterGap.length) return new Date(afterGap[0].epochMs);
  throw new RangeError(`Cannot resolve local reminder time in ${timezone}`);
}

function nextRepeatDueAt(dueAtUtc, repeatRule, timezone = 'UTC', nowMs = Date.now(), anchorAtUtc = dueAtUtc) {
  if (!dueAtUtc || !repeatRule || repeatRule.type === 'none') return null;
  const due = new Date(dueAtUtc);
  if (Number.isNaN(due.getTime())) return null;
  const anchor = new Date(anchorAtUtc || dueAtUtc);
  const scheduleAnchor = Number.isNaN(anchor.getTime()) ? due : anchor;
  let zone = String(timezone || 'UTC');
  try { partsAt(due.getTime(), zone); } catch { zone = 'UTC'; }
  let local = partsAt(due.getTime(), zone);
  const anchorLocal = partsAt(scheduleAnchor.getTime(), zone);
  const milliseconds = scheduleAnchor.getUTCMilliseconds();
  const type = repeatRule.type;
  if (!['daily', 'weekly', 'monthly', 'custom_days'].includes(type)) return null;
  const interval = type === 'daily' ? 1 : type === 'weekly' ? 7 : type === 'custom_days'
    ? Math.max(1, Math.floor(Number(repeatRule.intervalDays) || 1)) : 0;
  for (let guard = 0; guard < 100000; guard += 1) {
    if (type === 'monthly') {
      const firstOfNextMonth = new Date(Date.UTC(local.year, local.month, 1));
      const lastDay = new Date(Date.UTC(firstOfNextMonth.getUTCFullYear(), firstOfNextMonth.getUTCMonth() + 1, 0)).getUTCDate();
      local = { ...local, year: firstOfNextMonth.getUTCFullYear(), month: firstOfNextMonth.getUTCMonth() + 1,
        day: Math.min(anchorLocal.day, lastDay), hour: anchorLocal.hour, minute: anchorLocal.minute, second: anchorLocal.second };
    } else {
      const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + interval));
      local = { ...local, year: nextDate.getUTCFullYear(), month: nextDate.getUTCMonth() + 1, day: nextDate.getUTCDate() };
    }
    const next = instantAt(local, milliseconds, zone);
    if (next.getTime() > nowMs) return next.toISOString();
    local = partsAt(next.getTime(), zone);
  }
  throw new RangeError('Reminder recurrence exceeded the catch-up limit.');
}

function isRepeatOccurrence(anchorAtUtc, occurrenceAtUtc, repeatRule, timezone = 'UTC') {
  const anchor = new Date(anchorAtUtc);
  const target = new Date(occurrenceAtUtc);
  if (Number.isNaN(anchor.getTime()) || Number.isNaN(target.getTime())) return false;
  if (anchor.getTime() === target.getTime()) return true;
  if (!repeatRule || repeatRule.type === 'none') return false;
  let cursor = anchor;
  for (let step = 0; step < 100000; step += 1) {
    const next = nextRepeatDueAt(cursor.toISOString(), repeatRule, timezone, cursor.getTime() + 1, anchor.toISOString());
    if (!next) return false;
    const instant = new Date(next);
    if (instant.getTime() <= cursor.getTime()) throw new RangeError('Reminder recurrence did not advance time.');
    if (instant.getTime() === target.getTime()) return true;
    if (instant.getTime() > target.getTime()) return false;
    cursor = instant;
  }
  throw new RangeError('Reminder occurrence validation exceeded the supported catch-up limit.');
}

module.exports = { nextRepeatDueAt, isRepeatOccurrence };
