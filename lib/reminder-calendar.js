'use strict';

const DAY = 86400000;
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unexpected reminder fields');
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${name}`);
  return value;
}
function string(value, max, name, multiline = false) {
  if (typeof value !== 'string' || !value.isWellFormed() || !value.trim() || value.length > max ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) throw new TypeError(`Invalid ${name} (maximum ${max} characters)`);
  return value;
}
function clock(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new TypeError('Time must be HH:mm in 24-hour format');
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function localTimestamp(value, offset) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw new TypeError('Use a local date and time YYYY-MM-DDTHH:mm');
  clock(value.slice(11));
  const utc = Date.parse(value + ':00.000Z');
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 16) !== value || utc - offset * 60000 < 0) throw new TypeError('Invalid calendar date');
  return utc - offset * 60000;
}
function timezoneLabel(offset) {
  if (offset === 420) return 'WIB';
  if (offset === 480) return 'WITA';
  if (offset === 540) return 'WIT';
  return `UTC${offset < 0 ? '-' : '+'}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0')}:${String(Math.abs(offset) % 60).padStart(2, '0')}`;
}
function localDisplay(at, offset) { return at === null ? null : new Date(at + offset * 60000).toISOString().slice(0, 16) + ' ' + timezoneLabel(offset); }

function normalizeSchedule(input, now, defaultOffset) {
  object(input, ['kind', 'after_seconds', 'at', 'time', 'weekdays', 'day', 'every_seconds', 'start_at', 'end_at', 'timezone_offset_minutes']);
  const offset = input.timezone_offset_minutes === undefined ? defaultOffset : input.timezone_offset_minutes;
  integer(offset, -720, 840, 'timezone offset');
  const kind = input.kind;
  if (!['once', 'daily', 'weekly', 'monthly', 'interval'].includes(kind)) throw new TypeError('Choose once, daily, weekly, monthly or interval');
  const allowed = { once: ['after_seconds', 'at'], daily: ['time'], weekly: ['time', 'weekdays'], monthly: ['time', 'day'], interval: ['every_seconds'] }[kind];
  if (Object.keys(input).some(key => !['kind', 'start_at', 'end_at', 'timezone_offset_minutes', ...allowed].includes(key))) throw new TypeError('Fields do not match the schedule kind');
  const s = { kind, timezone_offset_minutes: offset, start_at: input.start_at === undefined ? now : localTimestamp(input.start_at, offset),
    end_at: input.end_at === undefined ? null : localTimestamp(input.end_at, offset) };
  if (s.end_at !== null && (s.end_at < s.start_at || s.end_at < now)) throw new TypeError('End must follow the start and must not be in the past');
  if (kind === 'once') {
    if ((input.at !== undefined) === (input.after_seconds !== undefined)) throw new TypeError('Provide either at or after_seconds');
    s.at = input.at !== undefined ? localTimestamp(input.at, offset) : now + integer(input.after_seconds, 1, 315360000, 'delay seconds') * 1000;
    if (s.at < now || s.at < s.start_at || s.end_at !== null && s.at > s.end_at) throw new TypeError('Reminder time must be in the future and within its date range');
  } else if (kind === 'interval') {
    s.every_ms = integer(input.every_seconds, 60, 315360000, 'interval seconds') * 1000;
    s.anchor = input.start_at === undefined ? now + s.every_ms : s.start_at;
  } else {
    s.minute = clock(input.time);
    if (kind === 'weekly') {
      if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.length > 7) throw new TypeError('Select weekdays, Monday=1 to Sunday=7');
      s.weekdays = [...new Set(input.weekdays.map(day => integer(day, 1, 7, 'weekday')))].sort();
    }
    if (kind === 'monthly') s.day = integer(input.day, 1, 31, 'day of month');
  }
  return s;
}

function dayIndex(at, offset) { return Math.floor((at + offset * 60000) / DAY); }
function weekday(day) { return ((day + 3) % 7 + 7) % 7 + 1; }
function dateMatches(s, day) {
  if (s.kind === 'daily') return true;
  if (s.kind === 'weekly') return s.weekdays.includes(weekday(day));
  return new Date(day * DAY).getUTCDate() === s.day;
}
function nextOccurrence(s, after) {
  const lower = Math.max(after + 1, s.start_at);
  let candidate;
  if (s.kind === 'once') candidate = s.at >= lower ? s.at : null;
  else if (s.kind === 'interval') candidate = s.anchor + Math.max(0, Math.ceil((lower - s.anchor) / s.every_ms)) * s.every_ms;
  else {
    let day = dayIndex(lower, s.timezone_offset_minutes);
    // All valid monthly dates recur within 62 days, including a missing February.
    for (let i = 0; i < 63; i++, day++) {
      const at = day * DAY + s.minute * 60000 - s.timezone_offset_minutes * 60000;
      if (at >= lower && dateMatches(s, day)) { candidate = at; break; }
    }
  }
  return candidate == null || s.end_at !== null && candidate > s.end_at || !Number.isSafeInteger(candidate) ? null : candidate;
}
function previousOccurrence(s, before) {
  const upper = Math.min(before, s.end_at === null ? before : s.end_at);
  let candidate;
  if (s.kind === 'once') candidate = s.at <= upper ? s.at : null;
  else if (s.kind === 'interval') candidate = s.anchor + Math.floor((upper - s.anchor) / s.every_ms) * s.every_ms;
  else {
    let day = dayIndex(upper, s.timezone_offset_minutes);
    for (let i = 0; i < 63; i++, day--) {
      const at = day * DAY + s.minute * 60000 - s.timezone_offset_minutes * 60000;
      if (at <= upper && dateMatches(s, day)) { candidate = at; break; }
    }
  }
  return candidate == null || candidate < s.start_at || s.kind === 'interval' && candidate < s.anchor ? null : candidate;
}
function occurrenceCount(s, first, last) {
  if (last < first) return 0;
  if (s.kind === 'once') return 1;
  if (s.kind === 'interval') return Math.floor((last - first) / s.every_ms) + 1;
  const a = dayIndex(first, s.timezone_offset_minutes), b = dayIndex(last, s.timezone_offset_minutes);
  if (s.kind === 'daily') return b - a + 1;
  if (s.kind === 'weekly') {
    const days = b - a + 1, weeks = Math.floor(days / 7);
    let count = weeks * s.weekdays.length;
    for (let i = 0; i < days % 7; i++) if (dateMatches(s, a + weeks * 7 + i)) count++;
    return count;
  }
  const start = new Date(a * DAY), end = new Date(b * DAY);
  let count = 0;
  for (let month = start.getUTCFullYear() * 12 + start.getUTCMonth(); month <= end.getUTCFullYear() * 12 + end.getUTCMonth(); month++) {
    const d = new Date(0); d.setUTCFullYear(Math.floor(month / 12), month % 12, s.day); d.setUTCHours(0, 0, 0, 0);
    const index = d.getTime() / DAY;
    if (d.getUTCDate() === s.day && index >= a && index <= b) count++;
  }
  return count;
}
function scheduleSummary(s) {
  const zone = timezoneLabel(s.timezone_offset_minutes);
  const time = s.minute === undefined ? '' : `${String(Math.floor(s.minute / 60)).padStart(2, '0')}:${String(s.minute % 60).padStart(2, '0')} ${zone}`;
  const days = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  let summary = s.kind === 'once' ? localDisplay(s.at, s.timezone_offset_minutes) : s.kind === 'interval' ? `Setiap ${s.every_ms / 60000} menit (${zone})` :
    s.kind === 'daily' ? `Setiap hari ${time}` : s.kind === 'weekly' ? `Setiap ${s.weekdays.map(day => days[day - 1]).join(', ')} ${time}` : `Setiap tanggal ${s.day}, ${time}; bulan tanpa tanggal tersebut dilewati`;
  if (s.end_at !== null) summary += `; berakhir ${localDisplay(s.end_at, s.timezone_offset_minutes)}`;
  return summary;
}
function quietNow(settings, now) {
  if (!settings.quiet_enabled) return false;
  const d = new Date(now + settings.timezone_offset_minutes * 60000), minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const from = clock(settings.quiet_start), to = clock(settings.quiet_end);
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}
module.exports = { DAY, object, integer, string, clock, normalizeSchedule, nextOccurrence, previousOccurrence, occurrenceCount, scheduleSummary, localDisplay, quietNow };
