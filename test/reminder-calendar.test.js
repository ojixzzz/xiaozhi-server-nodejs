'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSchedule, nextOccurrence, previousOccurrence, occurrenceCount, quietNow, localDisplay } = require('../lib/reminder-calendar');
const at = value => Date.parse(value + 'Z');
const start = at('2026-10-09T00:00:00');
const schedule = input => normalizeSchedule(input, start, 420);

test('relative, absolute and anchored interval schedules use device time independently of host timezone', () => {
  const once = schedule({ kind: 'once', after_seconds: 300 });
  assert.equal(nextOccurrence(once, start - 1), start + 300000);
  const absolute = schedule({ kind: 'once', at: '2026-10-09T08:00' });
  assert.equal(nextOccurrence(absolute, start), at('2026-10-09T01:00:00'));
  assert.equal(localDisplay(absolute.at, 420), '2026-10-09T08:00 WIB');
  const interval = schedule({ kind: 'interval', every_seconds: 7200 });
  const late = start + 7 * 3600000;
  assert.equal(previousOccurrence(interval, late), start + 6 * 3600000);
  assert.equal(nextOccurrence(interval, late), start + 8 * 3600000);
  assert.equal(occurrenceCount(interval, start + 2 * 3600000, start + 6 * 3600000), 3);
});

test('daily and weekday schedules cross local midnight and count skipped occurrences', () => {
  const daily = schedule({ kind: 'daily', time: '08:00' });
  const first = at('2026-10-09T01:00:00'), last = at('2026-10-12T01:00:00');
  assert.equal(nextOccurrence(daily, start), first);
  assert.equal(previousOccurrence(daily, last + 1000), last);
  assert.equal(occurrenceCount(daily, first, last), 4);
  const weekly = schedule({ kind: 'weekly', time: '19:00', weekdays: [5, 1, 5] });
  assert.deepEqual(weekly.weekdays, [1, 5]);
  assert.equal(nextOccurrence(weekly, start), at('2026-10-09T12:00:00'));
  assert.equal(nextOccurrence(weekly, at('2026-10-09T12:00:00')), at('2026-10-12T12:00:00'));
  assert.equal(occurrenceCount(weekly, at('2026-10-09T12:00:00'), at('2026-10-23T12:00:00')), 5);
});

test('monthly dates skip missing months, honor leap years, and cross year boundaries', () => {
  const monthly = normalizeSchedule({ kind: 'monthly', day: 31, time: '08:00' }, at('2026-01-01T00:00:00'), 420);
  assert.equal(nextOccurrence(monthly, at('2026-01-31T01:00:00')), at('2026-03-31T01:00:00'));
  assert.equal(previousOccurrence(monthly, at('2026-03-01T00:00:00')), at('2026-01-31T01:00:00'));
  assert.equal(nextOccurrence(monthly, at('2026-12-31T01:00:00')), at('2027-01-31T01:00:00'));
  assert.equal(occurrenceCount(monthly, at('2026-01-31T01:00:00'), at('2026-12-31T01:00:00')), 7);
  const leap = normalizeSchedule({ kind: 'monthly', day: 29, time: '08:00' }, at('2028-01-01T00:00:00'), 420);
  assert.equal(nextOccurrence(leap, at('2028-02-01T00:00:00')), at('2028-02-29T01:00:00'));
});

test('inclusive date ranges, invalid dates, ambiguous clocks and illegal fields are validated', () => {
  const ranged = schedule({ kind: 'daily', time: '08:00', start_at: '2026-10-10T08:00', end_at: '2026-10-11T08:00' });
  assert.equal(nextOccurrence(ranged, start), at('2026-10-10T01:00:00'));
  assert.equal(nextOccurrence(ranged, at('2026-10-11T01:00:00')), null);
  assert.equal(previousOccurrence(ranged, at('2026-10-20T00:00:00')), at('2026-10-11T01:00:00'));
  for (const input of [
    { kind: 'once', at: '2026-02-30T08:00' }, { kind: 'once', after_seconds: -1 },
    { kind: 'once', after_seconds: 10, at: '2026-10-10T08:00' },
    { kind: 'daily', time: '7' }, { kind: 'weekly', time: '08:00', weekdays: [8] },
    { kind: 'monthly', time: '08:00', day: 32 }, { kind: 'interval', every_seconds: 59 },
    { kind: 'daily', time: '08:00', device_id: 'other' }
  ]) assert.throws(() => schedule(input), TypeError);
});

test('quiet hours apply at exact boundaries, crossing midnight and with another device timezone', () => {
  const settings = { timezone_offset_minutes: 420, quiet_enabled: true, quiet_start: '22:00', quiet_end: '07:00' };
  assert.equal(quietNow(settings, at('2026-10-09T14:59:00')), false);
  assert.equal(quietNow(settings, at('2026-10-09T15:00:00')), true);
  assert.equal(quietNow(settings, at('2026-10-09T23:59:00')), true);
  assert.equal(quietNow(settings, at('2026-10-10T00:00:00')), false);
  assert.equal(quietNow({ ...settings, timezone_offset_minutes: 540 }, at('2026-10-09T14:00:00')), true);
  assert.equal(quietNow({ ...settings, quiet_enabled: false }, at('2026-10-09T15:00:00')), false);
});
