'use strict';

const { randomUUID } = require('node:crypto');
const { DAY, object, integer, clock, quietNow, localDisplay } = require('./reminder-calendar');
const DEFAULTS = Object.freeze({ interval_minutes: 30, rest_minutes: 2, active_start: '08:00', active_end: '17:00',
  weekdays: [1,2,3,4,5], auto_start: false, language: 'id' });

function normalizeSettings(input, previous = DEFAULTS) {
  object(input, Object.keys(DEFAULTS));
  const value = { ...previous, ...input };
  integer(value.interval_minutes, 5, 240, 'work interval (5..240 minutes)');
  integer(value.rest_minutes, 1, 30, 'rest duration (1..30 minutes)');
  clock(value.active_start); clock(value.active_end);
  if (value.active_start === value.active_end) throw new TypeError('Active start and end must differ');
  if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7) throw new TypeError('Choose active weekdays');
  value.weekdays = [...new Set(value.weekdays.map(day => integer(day, 1, 7, 'weekday')))].sort();
  if (typeof value.auto_start !== 'boolean' || !['id','en'].includes(value.language)) throw new TypeError('Invalid automatic start or language');
  return value;
}
function activeWindow(settings, now, offset) {
  const shifted = now + offset * 60000, day = Math.floor(shifted / DAY);
  const startMinute = clock(settings.active_start), endMinute = clock(settings.active_end);
  for (const index of [day, day - 1]) {
    const weekday = ((index + 3) % 7 + 7) % 7 + 1;
    const start = index * DAY + startMinute * 60000 - offset * 60000;
    const end = index * DAY + endMinute * 60000 - offset * 60000 + (endMinute < startMinute ? DAY : 0);
    if (settings.weekdays.includes(weekday) && now >= start && now < end) return { start, end };
  }
  return null;
}
function createScreenBreakStorage(db, { device, reminderSettings, fingerprint }) {
  const sql = query => db.prepare(query);
  function read(key) {
    const row = sql('SELECT * FROM screen_break_settings WHERE device_key=?').get(key);
    return row ? { settings: JSON.parse(row.settings), session: JSON.parse(row.session) } :
      { settings: { ...DEFAULTS }, session: { state: 'idle', next_at: null, rest_until: null, window_end: null, last_auto_at: null, revision: 0 } };
  }
  function write(key, value) {
    device.run(key);
    sql('INSERT INTO screen_break_settings VALUES (?,?,?) ON CONFLICT(device_key) DO UPDATE SET settings=excluded.settings,session=excluded.session')
      .run(key, JSON.stringify(value.settings), JSON.stringify(value.session));
  }
  function publicView(value, offset, now) {
    const { command_key, command_hash, receipts, ...session } = value.session;
    return { settings: value.settings, session, timezone_offset_minutes: offset, now_local: localDisplay(now, offset),
      next_local: localDisplay(session.next_at, offset), rest_until_local: localDisplay(session.rest_until, offset) };
  }
  function finishPending(key, now, reason) {
    sql("UPDATE screen_break_events SET status='skipped',reason=?,updated_at=? WHERE device_key=? AND status='pending'").run(reason, now, key);
  }
  function add(key, kind, due, now) {
    sql("INSERT INTO screen_break_events VALUES (?,?,?,?,?,'pending','',?,?)").run(randomUUID(), key, kind, due, due + 120000, now, now);
  }
  function run({ key, now, operation, input, defaultOffset }) {
    const action = operation.slice('screen_'.length), value = read(key), settings = value.settings, session = value.session;
    const time = reminderSettings(key, defaultOffset), window = activeWindow(settings, now, time.timezone_offset_minutes);
    if (action === 'get') { object(input, []); return publicView(value, time.timezone_offset_minutes, now); }
    if (action === 'history') {
      object(input, ['limit','offset']); const limit = integer(input.limit ?? 20, 1, 50, 'limit'), offset = integer(input.offset ?? 0, 0, 1000, 'offset');
      const rows = sql('SELECT * FROM screen_break_events WHERE device_key=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(key, limit + 1, offset);
      return { events: rows.slice(0, limit).map(({ device_key, ...event }) => event), has_more: rows.length > limit, playback_acknowledgement: false };
    }
    if (action === 'update') {
      value.settings = normalizeSettings(input, settings); session.revision++;
      finishPending(key, now, 'settings_changed');
      const updatedWindow = activeWindow(value.settings, now, time.timezone_offset_minutes);
      if (!updatedWindow) { session.state = 'idle'; session.next_at = session.rest_until = null; }
      else {
        session.window_end = updatedWindow.end;
        if (session.state === 'working') session.next_at = now + value.settings.interval_minutes * 60000;
      }
      write(key, value); return publicView(value, time.timezone_offset_minutes, now);
    }
    if (action === 'command') {
      object(input, ['action','minutes','request_key']);
      if (!['start','stop','rest','resume','snooze','skip'].includes(input.action)) throw new TypeError('Invalid screen break action');
      if (input.minutes !== undefined) integer(input.minutes, 1, input.action === 'snooze' ? 240 : 30, 'minutes');
      if (input.minutes !== undefined && !['snooze','rest'].includes(input.action)) throw new TypeError('Minutes only apply to rest or snooze');
      if (input.request_key !== undefined && (typeof input.request_key !== 'string' || input.request_key.length > 128 || !input.request_key)) throw new TypeError('Invalid request key');
      const hash = fingerprint({ action: input.action, minutes: input.minutes });
      const receipt = session.receipts?.find(item => item.key === input.request_key);
      if (input.request_key && (receipt || input.request_key === session.command_key)) {
        if (hash !== (receipt?.hash ?? session.command_hash)) throw Object.assign(new Error('Command key reused with different content'), { code: 'REMINDER_CONFLICT' });
        return { ...publicView(value, time.timezone_offset_minutes, now), duplicate: true };
      }
      if (input.action !== 'stop' && !window) throw new TypeError('Outside the configured active hours/days');
      if (input.action === 'stop') {
        session.state = 'idle'; session.next_at = session.rest_until = null;
        // Stopping an automatic session prevents another start in this window.
        session.last_auto_at = window?.start ?? session.last_auto_at;
        finishPending(key, now, 'user_stopped');
      } else if (input.action === 'start' || input.action === 'resume') {
        if (session.state !== 'working') { session.state = 'working'; session.next_at = now + settings.interval_minutes * 60000; session.rest_until = null; }
        session.window_end = window.end; session.last_auto_at = window.start; finishPending(key, now, 'work_resumed');
      } else {
        if (session.state === 'idle') throw new TypeError('Start a work session first');
        if (input.action === 'rest') {
          session.state = 'resting'; session.rest_until = now + (input.minutes ?? settings.rest_minutes) * 60000; session.next_at = null;
          finishPending(key, now, 'rest_started');
        } else if (input.action === 'snooze') {
          if (session.state !== 'working') throw new TypeError('Snooze requires a work session');
          session.next_at = now + (input.minutes ?? 5) * 60000; finishPending(key, now, 'user_snoozed');
        } else {
          if (session.state !== 'working') throw new TypeError('Skip requires a work session');
          const recent = sql("SELECT id,status FROM screen_break_events WHERE device_key=? AND kind='break_due' AND due_at>=? ORDER BY due_at DESC LIMIT 1").get(key, now - 120000);
          if (recent) {
            sql("UPDATE screen_break_events SET status=CASE WHEN status='pending' THEN 'skipped' ELSE status END,reason='user_skipped',updated_at=? WHERE id=?").run(now,recent.id);
          }
          else session.next_at = Math.max(now, session.next_at ?? now) + settings.interval_minutes * 60000;
        }
      }
      session.revision++; session.command_key = input.request_key ?? null; session.command_hash = hash;
      if (input.request_key) session.receipts = [...(session.receipts || []).filter(item => now - item.at < 30 * DAY).slice(-127), { key: input.request_key, hash, at: now }];
      write(key, value); return publicView(value, time.timezone_offset_minutes, now);
    }
    if (action === 'claim') {
      object(input, ['id','revision']);
      const row = sql('SELECT * FROM screen_break_events WHERE device_key=? AND id=?').get(key, input.id);
      if (!row || row.status !== 'pending') return { allowed: false, reason: 'already_handled' };
      const reason = row.expires_at <= now ? 'expired' : !window || session.state === 'idle' ? 'inactive' :
        input.revision !== session.revision ? 'session_changed' : quietNow(time, now) ? 'quiet_hours' : null;
      if (reason) {
        sql("UPDATE screen_break_events SET status='skipped',reason=?,updated_at=? WHERE id=?").run(reason, now, row.id);
        return { allowed: false, reason };
      }
      // Claim commits before network publication: retries/restarts never replay.
      sql("UPDATE screen_break_events SET status='claimed',reason='publication_started',updated_at=? WHERE id=?").run(now, row.id);
      return { allowed: true };
    }
    if (action === 'result') {
      object(input, ['id','status','reason']);
      if (!['published','skipped','unknown'].includes(input.status) || typeof input.reason !== 'string' || !/^[a-z0-9_]{0,120}$/.test(input.reason)) throw new TypeError('Invalid announcement result');
      sql("UPDATE screen_break_events SET status=?,reason=?,updated_at=? WHERE device_key=? AND id=? AND status IN ('pending','claimed')")
        .run(input.status, input.reason, now, key, input.id); return { saved: true };
    }
    if (action !== 'tick') throw new TypeError('Unknown screen break operation');
    object(input, []);
    sql("UPDATE screen_break_events SET status='unknown',reason='publication_unconfirmed',updated_at=? WHERE device_key=? AND status='claimed' AND updated_at<=?")
      .run(now, key, now - 120000);
    if (session.state !== 'idle' && session.window_end !== null && session.window_end <= now) {
      session.state = 'idle'; session.next_at = session.rest_until = null; session.revision++; finishPending(key,now,'outside_active_hours');
    }
    if (!window) {
      if (session.state !== 'idle') { session.state = 'idle'; session.next_at = session.rest_until = null; session.revision++; }
      finishPending(key, now, 'outside_active_hours');
    } else {
      if (settings.auto_start && session.state === 'idle' && session.last_auto_at !== window.start) {
        session.state = 'working'; session.next_at = now + settings.interval_minutes * 60000; session.window_end = window.end;
        session.last_auto_at = window.start; session.revision++;
      }
      if (session.state === 'resting' && session.rest_until <= now) {
        const due = session.rest_until; session.state = 'working'; session.rest_until = null;
        session.next_at = (now - due < 120000 ? due : now) + settings.interval_minutes * 60000; session.revision++; add(key, 'break_end', due, now);
      } else if (session.state === 'working' && session.next_at <= now) {
        const interval = settings.interval_minutes * 60000;
        const latest = session.next_at + Math.floor((now - session.next_at) / interval) * interval;
        session.next_at = latest + interval; add(key, 'break_due', latest, now);
      }
    }
    // Avoid creating default rows for every device at every scheduler tick.
    if (sql('SELECT 1 FROM screen_break_settings WHERE device_key=?').get(key)) write(key, value);
    sql("UPDATE screen_break_events SET status='skipped',reason='expired',updated_at=? WHERE device_key=? AND status='pending' AND expires_at<=?").run(now, key, now);
    const events = sql("SELECT * FROM screen_break_events WHERE device_key=? AND status='pending' ORDER BY due_at LIMIT 2").all(key);
    return { ...publicView(value, time.timezone_offset_minutes, now), quiet: quietNow(time, now),
      events: events.map(({ device_key, ...event }) => ({ ...event, revision: session.revision })) };
  }
  function cleanup(now) { sql('DELETE FROM screen_break_events WHERE created_at<=?').run(now - 30 * DAY); }
  return { run, cleanup };
}
module.exports = { createScreenBreakStorage, normalizeSettings, activeWindow, DEFAULTS };
