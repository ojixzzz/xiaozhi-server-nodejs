'use strict';

// Runs only inside the inbox worker, sharing its SQLite transaction and scope.
const { createReminderExtras } = require('./reminder-extras');
const { createScreenBreakStorage } = require('./screen-break-storage');
const { randomUUID, createHash } = require('node:crypto');
const { DAY, object, integer, string, clock, normalizeSchedule, nextOccurrence, previousOccurrence,
  occurrenceCount, scheduleSummary, localDisplay, quietNow } = require('./reminder-calendar');

function migrateReminders(db) {
  db.exec(`
    CREATE TABLE reminder_settings (
      device_key TEXT PRIMARY KEY REFERENCES notification_devices(device_key) ON DELETE CASCADE,
      timezone_offset_minutes INTEGER NOT NULL,
      quiet_enabled INTEGER NOT NULL DEFAULT 0 CHECK(quiet_enabled IN (0,1)),
      quiet_start TEXT NOT NULL DEFAULT '22:00', quiet_end TEXT NOT NULL DEFAULT '07:00', last_beep_at INTEGER
    ) STRICT;
    CREATE TABLE reminder_schedules (
      id TEXT PRIMARY KEY, device_key TEXT NOT NULL REFERENCES notification_devices(device_key) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120), text TEXT NOT NULL CHECK(length(text) BETWEEN 1 AND 2000),
      schedule TEXT NOT NULL CHECK(json_valid(schedule)), status TEXT NOT NULL CHECK(status IN ('active','paused','finished','cancelled')),
      next_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      create_key TEXT, fingerprint TEXT NOT NULL, UNIQUE(device_key,create_key)
    ) STRICT;
    CREATE INDEX reminder_due ON reminder_schedules(device_key,status,next_at);
    CREATE TABLE reminder_occurrences (
      id TEXT PRIMARY KEY, reminder_id TEXT NOT NULL REFERENCES reminder_schedules(id) ON DELETE CASCADE,
      device_key TEXT NOT NULL REFERENCES notification_devices(device_key) ON DELETE CASCADE,
      due_at INTEGER NOT NULL, notification_id TEXT REFERENCES notification_inbox(id) ON DELETE SET NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','snoozed','completed','cancelled')),
      snooze_until INTEGER, snooze_key TEXT, snooze_seconds INTEGER, created_at INTEGER NOT NULL,
      completed_at INTEGER, skipped_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(reminder_id,due_at)
    ) STRICT;
    CREATE INDEX reminder_occurrence_device ON reminder_occurrences(device_key,created_at DESC,id);
    CREATE INDEX reminder_occurrence_notification ON reminder_occurrences(notification_id);
    PRAGMA user_version = 2;
  `);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function fingerprint(input) { return createHash('sha256').update(JSON.stringify(stable(input))).digest('hex'); }
function id(value) { if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/.test(value)) throw new TypeError('Use an exact reminder or occurrence ID'); return value; }
function error(code, message) { return Object.assign(new Error(message), { code }); }

function createReminderStorage(db, { statements, notificationRecord, maxInbox }) {
  const sql = query => db.prepare(query);
  const scheduleRow = (key, reminderId) => sql('SELECT * FROM reminder_schedules WHERE device_key=? AND id=?').get(key, id(reminderId));
  function settings(key, fallback) {
    integer(fallback, -720, 840, 'default timezone');
    const row = sql('SELECT * FROM reminder_settings WHERE device_key=?').get(key);
    return row ? { timezone_offset_minutes: row.timezone_offset_minutes, quiet_enabled: Boolean(row.quiet_enabled), quiet_start: row.quiet_start, quiet_end: row.quiet_end } :
      { timezone_offset_minutes: fallback, quiet_enabled: false, quiet_start: '22:00', quiet_end: '07:00' };
  }
  function view(row) {
    if (!row) return null;
    const schedule = JSON.parse(row.schedule);
    return { id: row.id, title: row.title, text: row.text, schedule, status: row.status, revision: row.revision,
      next_at: row.next_at, next_local: localDisplay(row.next_at, schedule.timezone_offset_minutes),
      summary: scheduleSummary(schedule), created_at: row.created_at, updated_at: row.updated_at };
  }
  const extras = createReminderExtras(db, { settings, scheduleRow, id, view, fail: error });
  const screen = createScreenBreakStorage(db, { device: statements.device, reminderSettings: settings, fingerprint });
  function nextUnskipped(reminderId, schedule, after) {
    let next = nextOccurrence(schedule,after);
    while (next !== null && sql('SELECT 1 FROM reminder_skips WHERE reminder_id=? AND due_at=?').get(reminderId,next)) next = nextOccurrence(schedule,next);
    return next;
  }
  function history(key, reminderId, limit, offset) {
    return sql(`SELECT o.*, n.read_at, r.title, r.status AS schedule_status, EXISTS(SELECT 1 FROM reminder_skips s WHERE s.reminder_id=o.reminder_id AND s.due_at=o.due_at) AS user_skipped FROM reminder_occurrences o
      JOIN reminder_schedules r ON r.id=o.reminder_id LEFT JOIN notification_inbox n ON n.id=o.notification_id
      WHERE o.device_key=? AND (? IS NULL OR o.reminder_id=?) ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?`)
      .all(key, reminderId, reminderId, limit, offset).map(row => ({ id: row.id, reminder_id: row.reminder_id,
        notification_id: row.notification_id, title: row.title, due_at: row.due_at, state: row.user_skipped ? 'skipped' : row.state,
        schedule_status: row.schedule_status, snooze_until: row.snooze_until, read_at: row.read_at,
        completed_at: row.completed_at, skipped_count: row.skipped_count, created_at: row.created_at }));
  }
  function cleanup(now) {
    extras.cleanup(now); screen.cleanup(now);
    sql('DELETE FROM reminder_occurrences WHERE max(created_at,due_at)<=?').run(now - 30 * DAY);
    sql("DELETE FROM reminder_schedules WHERE status IN ('cancelled','finished') AND updated_at<=? AND NOT EXISTS (SELECT 1 FROM reminder_occurrences WHERE reminder_id=reminder_schedules.id)").run(now - 30 * DAY);
  }
  function canBeep(key, notificationId, now, fallback) {
    if (quietNow(settings(key, fallback), now)) return { allowed: false, reason: 'quiet_hours' };
    const row = sql(`SELECT o.state,r.status FROM reminder_occurrences o JOIN reminder_schedules r ON r.id=o.reminder_id
      WHERE o.device_key=? AND o.notification_id=?`).get(key, notificationId);
    if (row && (row.state !== 'pending' || !['active', 'finished'].includes(row.status))) return { allowed: false, reason: 'reminder_inactive' };
    return { allowed: true };
  }
  function run(p) {
    const { key, now, operation: action, input = {}, defaultOffset = 420 } = p;
    if (action.startsWith('screen_')) return screen.run(p);
    object(input, {
      settings_get: [], settings_update: ['timezone_offset_minutes', 'quiet_enabled', 'quiet_start', 'quiet_end'],
      create: ['title', 'text', 'schedule', 'request_key'], list: ['status', 'limit', 'offset'],
      get: ['id', 'limit', 'offset'], history: ['reminder_id', 'limit', 'offset'],
      update: ['id', 'title', 'text', 'schedule', 'status', 'revision'], cancel: ['id'],
      complete: ['occurrence_id'], snooze: ['occurrence_id', 'seconds', 'request_key'],
      skip: ['id','due_at','occurrence_id'], agenda: ['from','days','limit','offset'], calendar: ['from','days'], trace: ['occurrence_id','notification_id'],
      tick: [], can_beep: ['notification_id'], claim_beep: ['notification_id','interval_ms']
    }[action] || []);
    if (action === 'skip') return extras.skip(key, input, now);
    if (action === 'agenda' || action === 'calendar') return extras.agenda(key, input, now, defaultOffset, action === 'calendar');
    if (action === 'trace') return extras.trace(key, input);
    if (action === 'settings_get') return settings(key, defaultOffset);
    if (action === 'can_beep') return canBeep(key, id(input.notification_id), now, defaultOffset);
    if (action === 'claim_beep') {
      const eligibility = canBeep(key, id(input.notification_id), now, defaultOffset);
      if (!eligibility.allowed) return eligibility;
      const interval = integer(input.interval_ms, 1, DAY, 'beep interval');
      const row = sql('SELECT last_beep_at FROM reminder_settings WHERE device_key=?').get(key);
      if (row?.last_beep_at !== null && row?.last_beep_at !== undefined && now - row.last_beep_at < interval) return { allowed: false, reason: 'beep_interval' };
      const value = settings(key, defaultOffset); statements.device.run(key);
      sql(`INSERT INTO reminder_settings(device_key,timezone_offset_minutes,quiet_enabled,quiet_start,quiet_end,last_beep_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(device_key) DO UPDATE SET last_beep_at=excluded.last_beep_at`)
        .run(key, value.timezone_offset_minutes, value.quiet_enabled ? 1 : 0, value.quiet_start, value.quiet_end, now);
      return { allowed: true };
    }
    if (action === 'settings_update') {
      const value = { ...settings(key, defaultOffset), ...input };
      integer(value.timezone_offset_minutes, -720, 840, 'timezone offset');
      if (typeof value.quiet_enabled !== 'boolean') throw new TypeError('quiet_enabled must be boolean');
      clock(value.quiet_start); clock(value.quiet_end);
      if (value.quiet_start === value.quiet_end) throw new TypeError('Quiet start and end must differ');
      statements.device.run(key);
      sql(`INSERT INTO reminder_settings(device_key,timezone_offset_minutes,quiet_enabled,quiet_start,quiet_end) VALUES (?,?,?,?,?) ON CONFLICT(device_key) DO UPDATE SET
        timezone_offset_minutes=excluded.timezone_offset_minutes,quiet_enabled=excluded.quiet_enabled,quiet_start=excluded.quiet_start,quiet_end=excluded.quiet_end`)
        .run(key, value.timezone_offset_minutes, value.quiet_enabled ? 1 : 0, value.quiet_start, value.quiet_end);
      return value;
    }
    if (['list', 'get', 'history'].includes(action)) {
      const limit = integer(input.limit === undefined ? 20 : input.limit, 1, 50, 'page limit');
      const offset = integer(input.offset === undefined ? 0 : input.offset, 0, 100000, 'page offset');
      if (action === 'history') {
        const rows = history(key, input.reminder_id === undefined ? null : id(input.reminder_id), limit + 1, offset);
        return { occurrences: rows.slice(0, limit), has_more: rows.length > limit };
      }
      if (action === 'get') {
        const row = scheduleRow(key, input.id);
        if (!row) throw error('REMINDER_NOT_FOUND', 'Reminder not found for this device');
        const occurrences = history(key, row.id, limit + 1, offset);
        return { reminder: view(row), occurrences: occurrences.slice(0, limit), has_more: occurrences.length > limit };
      }
      const status = input.status || 'all';
      if (!['all', 'active', 'paused', 'finished', 'cancelled'].includes(status)) throw new TypeError('Invalid reminder status');
      const rows = sql('SELECT * FROM reminder_schedules WHERE device_key=? AND (?=\'all\' OR status=?) ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(key, status, status, limit + 1, offset);
      return { reminders: rows.slice(0, limit).map(view), has_more: rows.length > limit };
    }
    if (action === 'create') {
      const title = string(input.title, 120, 'title'), text = string(input.text === undefined ? title : input.text, 2000, 'text', true);
      const requestKey = input.request_key === undefined ? null : string(input.request_key, 128, 'request key');
      const hash = fingerprint({ title, text, schedule: input.schedule });
      if (requestKey !== null) {
        const prior = sql('SELECT * FROM reminder_schedules WHERE device_key=? AND create_key=?').get(key, requestKey);
        if (prior) {
          if (prior.fingerprint !== hash) throw error('REMINDER_CONFLICT', 'Request key already used with different reminder content');
          return { reminder: view(prior), duplicate: true };
        }
      }
      const schedule = normalizeSchedule(input.schedule, now, settings(key, defaultOffset).timezone_offset_minutes);
      const next = nextOccurrence(schedule, now - 1);
      if (next === null) throw new TypeError('No future occurrence within this date range');
      if (sql("SELECT count(*) AS n FROM reminder_schedules WHERE device_key=? AND status IN ('active','paused')").get(key).n >= 100) throw error('REMINDER_CAPACITY', 'Maximum 100 active or paused schedules per device');
      const reminderId = randomUUID(); statements.device.run(key);
      sql('INSERT INTO reminder_schedules VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(reminderId, key, title, text, JSON.stringify(schedule), 'active', next, now, now, 1, requestKey, hash);
      return { reminder: view(scheduleRow(key, reminderId)), duplicate: false };
    }
    if (action === 'update' || action === 'cancel') {
      const row = scheduleRow(key, input.id);
      if (!row) throw error('REMINDER_NOT_FOUND', 'Reminder not found for this device');
      if (input.revision !== undefined && integer(input.revision, 1, Number.MAX_SAFE_INTEGER, 'revision') !== row.revision) throw error('REMINDER_CONFLICT', 'Reminder changed; refresh before editing');
      if (action === 'cancel') {
        extras.occurrenceEvents(key, row.id, 'cancelled', now);
        sql("UPDATE reminder_schedules SET status='cancelled',next_at=NULL,updated_at=?,revision=revision+1 WHERE id=?").run(now, row.id);
        sql("UPDATE notification_inbox SET read_at=coalesce(read_at,?) WHERE id IN (SELECT notification_id FROM reminder_occurrences WHERE reminder_id=? AND state IN ('pending','snoozed'))").run(now, row.id);
        sql("UPDATE reminder_occurrences SET state='cancelled',snooze_until=NULL WHERE reminder_id=? AND state IN ('pending','snoozed')").run(row.id);
      } else {
        if (row.status === 'cancelled') throw new TypeError('Cancelled schedules cannot be resumed; create a new schedule');
        const title = input.title === undefined ? row.title : string(input.title, 120, 'title');
        const text = input.text === undefined ? row.text : string(input.text, 2000, 'text', true);
        const schedule = input.schedule === undefined ? JSON.parse(row.schedule) : normalizeSchedule(input.schedule, now, JSON.parse(row.schedule).timezone_offset_minutes);
        let status = input.status === undefined ? row.status : input.status;
        if (!['active', 'paused', 'finished'].includes(status) || input.status === 'finished') throw new TypeError('Set status to active or paused');
        if (input.schedule !== undefined && status === 'finished') status = 'active';
        if (['active', 'paused'].includes(status) && !['active', 'paused'].includes(row.status) && sql("SELECT count(*) AS n FROM reminder_schedules WHERE device_key=? AND status IN ('active','paused')").get(key).n >= 100) throw error('REMINDER_CAPACITY', 'Maximum 100 active or paused schedules per device');
        let next = row.next_at;
        if (input.schedule !== undefined || row.status === 'paused' && status === 'active' || row.status === 'finished' && status === 'active') next = nextUnskipped(row.id, schedule, now - 1);
        if (next === null && status === 'active') status = 'finished';
        if (status !== row.status) extras.occurrenceEvents(key, row.id, status === 'paused' ? 'paused' : 'resumed', now);
        sql('UPDATE reminder_schedules SET title=?,text=?,schedule=?,status=?,next_at=?,updated_at=?,revision=revision+1 WHERE id=?')
          .run(title, text, JSON.stringify(schedule), status, next, now, row.id);
      }
      return { reminder: view(scheduleRow(key, row.id)) };
    }
    if (action === 'complete' || action === 'snooze') {
      const row = sql(`SELECT o.*,r.status AS schedule_status FROM reminder_occurrences o JOIN reminder_schedules r ON r.id=o.reminder_id
        WHERE o.device_key=? AND o.id=?`).get(key, id(input.occurrence_id));
      if (!row) throw error('REMINDER_NOT_FOUND', 'Occurrence not found for this device');
      if (action === 'snooze' && row.state !== 'completed' && row.state !== 'cancelled') {
        if (row.schedule_status === 'cancelled' || !row.notification_id) throw new TypeError('Occurrence is cancelled or its notification expired');
        const seconds = integer(input.seconds, 1, 30 * DAY / 1000, 'snooze seconds');
        const requestKey = input.request_key === undefined ? null : string(input.request_key, 128, 'request key');
        if (requestKey !== null && row.snooze_key === requestKey) {
          if (row.snooze_seconds !== seconds) throw error('REMINDER_CONFLICT', 'Snooze request key already used with another delay');
        } else {
          sql("UPDATE reminder_occurrences SET state='snoozed',snooze_until=?,snooze_key=?,snooze_seconds=? WHERE id=?").run(now + seconds * 1000, requestKey, seconds, row.id);
          statements.markRead.run(now, key, row.notification_id);
          extras.event(key, row.notification_id, row.id, 'snoozed', '', now);
        }
      } else if (action === 'snooze') throw new TypeError('Completed or cancelled occurrences cannot be snoozed');
      else if (row.state !== 'completed') {
        if (row.state === 'cancelled') throw new TypeError('Cancelled occurrences cannot be completed');
        sql("UPDATE reminder_occurrences SET state='completed',completed_at=?,snooze_until=NULL WHERE id=?").run(now, row.id);
        if (row.notification_id) statements.markRead.run(now, key, row.notification_id);
        extras.event(key, row.notification_id, row.id, 'completed', '', now);
      }
      const updated = sql('SELECT * FROM reminder_occurrences WHERE device_key=? AND id=?').get(key, row.id);
      return { occurrence: { id: updated.id, reminder_id: updated.reminder_id, notification_id: updated.notification_id,
        state: updated.state, due_at: updated.due_at, snooze_until: updated.snooze_until, completed_at: updated.completed_at } };
    }
    if (action === 'tick') {
      const notifications = [], deferred = [];
      const due = sql("SELECT * FROM reminder_schedules WHERE device_key=? AND status='active' AND next_at<=? ORDER BY next_at LIMIT 100").all(key, now);
      for (const row of due) {
        const schedule = JSON.parse(row.schedule), latest = previousOccurrence(schedule, now);
        if (latest === null || latest < row.next_at) continue;
        if (sql('SELECT 1 FROM reminder_skips WHERE reminder_id=? AND due_at=?').get(row.id, latest)) {
          const next = nextUnskipped(row.id, schedule, now);
          sql('UPDATE reminder_schedules SET next_at=?,status=?,updated_at=? WHERE id=?').run(next, next === null ? 'finished' : 'active', now, row.id); continue;
        }
        if (statements.count.get(key).count >= maxInbox) { deferred.push(row.id); continue; }
        const deliberateSkips = sql('SELECT due_at FROM reminder_skips WHERE reminder_id=? AND due_at>=? AND due_at<?')
          .all(row.id,row.next_at,latest).filter(item => nextOccurrence(schedule,item.due_at - 1) === item.due_at).length;
        const notificationId = randomUUID(), occurrenceId = randomUUID(), skipped = Math.max(0,occurrenceCount(schedule, row.next_at, latest) - 1 - deliberateSkips);
        const prior = sql('SELECT id FROM reminder_occurrences WHERE reminder_id=? AND due_at=?').get(row.id, latest);
        if (!prior) {
          // Reserved sender namespace cannot be selected by an external token.
          statements.insert.run(notificationId, key, '@xiaozhi-reminders', row.title, row.text, `reminder-${row.id}-${latest}`, now);
          sql('INSERT INTO reminder_occurrences(id,reminder_id,device_key,due_at,notification_id,state,created_at,skipped_count) VALUES (?,?,?,?,?,\'pending\',?,?)')
            .run(occurrenceId, row.id, key, latest, notificationId, now, skipped);
          extras.event(key, notificationId, occurrenceId, 'due', skipped ? 'missed_occurrences_coalesced' : '', latest);
          extras.event(key, notificationId, occurrenceId, 'stored', '', now);
          notifications.push(notificationRecord(statements.scoped.get(key, notificationId)));
        }
        const next = nextUnskipped(row.id, schedule, now);
        sql('UPDATE reminder_schedules SET next_at=?,status=?,updated_at=? WHERE id=?').run(next, next === null ? 'finished' : 'active', now, row.id);
      }
      const snoozes = sql(`SELECT o.* FROM reminder_occurrences o JOIN reminder_schedules r ON r.id=o.reminder_id
        WHERE o.device_key=? AND o.state='snoozed' AND o.snooze_until<=? AND r.status IN ('active','finished')`).all(key, now);
      for (const row of snoozes) {
        sql("UPDATE reminder_occurrences SET state=?,snooze_until=NULL WHERE id=?").run(row.notification_id ? 'pending' : 'cancelled', row.id);
        if (!row.notification_id) continue;
        sql("UPDATE notification_inbox SET read_at=NULL,beep_status='not_published',beep_reason='snooze_due',beep_updated_at=NULL WHERE id=?").run(row.notification_id);
        extras.event(key, row.notification_id, row.id, 'snooze_due', '', now);
        notifications.push(notificationRecord(statements.scoped.get(key, row.notification_id)));
      }
      return { notifications, deferred };
    }
    throw new TypeError('Unknown reminder operation');
  }
  return { run, cleanup, canBeep, notificationEvent: extras.notificationEvent };
}
module.exports = { migrateReminders, createReminderStorage, fingerprint };
