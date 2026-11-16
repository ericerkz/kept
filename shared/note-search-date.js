// Shared by the web/native UI and server pagination. Date-looking text is
// ordinary text unless it follows !date. Ranges use the caller's local days.
const months = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const monthNames = months.flatMap(name => [name, name.slice(0, 3)]).concat('sept').join('|');
const weekdayNames = weekdays.flatMap(name => [name, name.slice(0, 3)]).join('|');
const quantities = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

function calendarDate(year, month, day) {
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(0, 0, 0, 0);
  return date;
}

function dayRange(date) {
  const start = calendarDate(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function calendarRange(year, month, day) {
  if (year < 1 || year > 9999 || (month !== undefined && (month < 0 || month > 11))) return null;
  const start = calendarDate(year, month ?? 0, day ?? 1);
  if (start.getFullYear() !== year || (month !== undefined && start.getMonth() !== month) ||
    (day !== undefined && start.getDate() !== day)) return null;
  if (day !== undefined) return dayRange(start);
  return { start, end: month === undefined ? calendarDate(year + 1, 0, 1) : calendarDate(year, month + 1, 1) };
}

function datePrefix(text, now) {
  // Longest forms come first, so a year or month cannot swallow a full date.
  const forms = [
    /^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?(?=\s|$)/,
    new RegExp(`^(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\s|$)`, 'i'),
    new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:\\s+(\\d{4}))?(?=\\s|$)`, 'i'),
    new RegExp(`^(${monthNames})(?:\\s+(\\d{4}))?(?=\\s|$)`, 'i'),
    /^\d{4}(?=\s|$)/,
    /^(today|yesterday|tomorrow)(?=\s|$)/i,
    /^(this|last)\s+(week|month|year)(?=\s|$)/i,
    new RegExp(`^(last\\s+)?(${weekdayNames})(?=\\s|$)`, 'i'),
    /^(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month|year)s?\s+ago(?=\s|$)/i
  ];
  const monthIndex = value => months.findIndex(name => name.startsWith(value.toLowerCase()));
  for (let index = 0; index < forms.length; index++) {
    const match = text.match(forms[index]);
    if (!match) continue;
    let range = null;
    const year = now.getFullYear();
    if (index === 0) range = calendarRange(+match[1], +match[2] - 1, match[3] === undefined ? undefined : +match[3]);
    if (index === 1) range = calendarRange(match[3] ? +match[3] : year, monthIndex(match[1]), +match[2]);
    if (index === 2) range = calendarRange(match[3] ? +match[3] : year, monthIndex(match[2]), +match[1]);
    if (index === 3) range = calendarRange(match[2] ? +match[2] : year, monthIndex(match[1]));
    if (index === 4) range = calendarRange(+match[0]);
    if (index === 5) {
      const offset = { today: 0, yesterday: -1, tomorrow: 1 }[match[1].toLowerCase()];
      range = dayRange(calendarDate(year, now.getMonth(), now.getDate() + offset));
    }
    if (index === 6) {
      const previous = match[1].toLowerCase() === 'last' ? 1 : 0;
      const unit = match[2].toLowerCase();
      if (unit === 'year') range = calendarRange(year - previous);
      else if (unit === 'month') {
        const date = calendarDate(year, now.getMonth() - previous, 1);
        range = calendarRange(date.getFullYear(), date.getMonth());
      } else {
        // Calendar weeks start on Monday, consistently on every platform.
        const start = calendarDate(year, now.getMonth(), now.getDate() - (now.getDay() + 6) % 7 - previous * 7);
        range = { start, end: calendarDate(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
      }
    }
    if (index === 7) {
      const weekday = weekdays.findIndex(name => name.startsWith(match[2].toLowerCase()));
      let offset = (now.getDay() - weekday + 7) % 7;
      if (match[1] && offset === 0) offset = 7;
      range = dayRange(calendarDate(year, now.getMonth(), now.getDate() - offset));
    }
    if (index === 8) {
      const amount = /^\d+$/.test(match[1]) ? +match[1] : quantities.indexOf(match[1].toLowerCase());
      if (amount > 10000) return { length: match[0].length, range: null };
      const unit = match[2].toLowerCase();
      if (unit === 'year') range = calendarRange(year - amount);
      else if (unit === 'month') {
        const date = calendarDate(year, now.getMonth() - amount, 1);
        range = calendarRange(date.getFullYear(), date.getMonth());
      } else {
        const start = calendarDate(year, now.getMonth(), now.getDate() - amount * (unit === 'week' ? 7 : 1));
        range = { start, end: calendarDate(start.getFullYear(), start.getMonth(), start.getDate() + (unit === 'week' ? 7 : 1)) };
      }
    }
    return { length: match[0].length, range };
  }
  return null;
}

function parseDateSearch(query, now = new Date()) {
  const source = String(query || '');
  const filters = [];
  let invalid = false;
  let range = null;
  // Use offsets into the original string; only the date operand is removed.
  const pattern = /(^|\s)!date(?=\s|:|$)(?::\s*|\s+)?/gi;
  let match;
  let cursor = 0;
  const pieces = [];
  while ((match = pattern.exec(source))) {
    const valueStart = pattern.lastIndex;
    const parsed = datePrefix(source.slice(valueStart), now);
    const length = parsed?.length ?? (source.slice(valueStart).match(/^[^\s!]+/)?.[0].length || 0);
    const end = valueStart + length;
    filters.push({ code: source.slice(match.index + match[1].length, end), value: source.slice(valueStart, end), valid: !!parsed?.range });
    pieces.push(source.slice(cursor, match.index), match[1]);
    cursor = end;
    pattern.lastIndex = end;
    if (!parsed?.range) invalid = true;
    else if (!range) range = parsed.range;
    else range = { start: new Date(Math.max(+range.start, +parsed.range.start)), end: new Date(Math.min(+range.end, +parsed.range.end)) };
  }
  if (range && range.start >= range.end) invalid = true;
  pieces.push(source.slice(cursor));
  return { text: filters.length ? pieces.join('').replace(/\s+/g, ' ').trim() : source, filters, range, invalid };
}

module.exports = { parseDateSearch };
