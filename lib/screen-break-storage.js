'use strict';

const { randomUUID } = require('node:crypto');
const { DAY, object, integer, clock, quietNow, localDisplay } = require('./reminder-calendar');
const DEFAULTS = Object.freeze({ interval_minutes: 25, rest_minutes: 5, long_rest_minutes: 20, cycles_before_long_rest: 4, active_start: '08:00', active_end: '17:00',
  weekdays: [1,2,3,4,5], auto_start: false, language: 'id' });

function normalizeSettings(input, previous = DEFAULTS) {
  object(input, Object.keys(DEFAULTS));
  const value = { ...previous, ...input };
  integer(value.interval_minutes, 5, 240, 'work interval (5..240 minutes)');
  integer(value.rest_minutes, 1, 30, 'rest duration (1..30 minutes)');
  integer(value.long_rest_minutes, 1, 60, 'long rest duration (1..60 minutes)');
  integer(value.cycles_before_long_rest, 1, 12, 'focus sessions before long rest (1..12)');
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
  function read(key, now, defaultOffset) {
    const row = sql('SELECT * FROM screen_break_settings WHERE device_key=?').get(key);
    const savedSession = row ? JSON.parse(row.session) : {};
    const value = { settings: { ...DEFAULTS, ...(row ? JSON.parse(row.settings) : {}) },
      session: { state: 'idle', next_at: null, rest_until: null, window_end: null, last_auto_at: null, revision: 0,
        completed_focus: 0, total_focus: 0, rest_kind: null, rest_minutes: null, paused_state: null, remaining_ms: null,
        pomodoro_version: 1, ...savedSession } };
    if (row && savedSession.pomodoro_version !== 1) {
      // Upgrade the interval timer once; preserve custom durations, stop its old phase.
      if (value.settings.interval_minutes === 30 && value.settings.rest_minutes === 2) {
        value.settings.interval_minutes = 25; value.settings.rest_minutes = 5;
      }
      stop(value.session); value.session.completed_focus = value.session.total_focus = 0; value.session.pomodoro_version = 1;
      value.session.last_auto_at = activeWindow(value.settings, now, reminderSettings(key, defaultOffset).timezone_offset_minutes)?.start ?? value.session.last_auto_at;
      value.session.revision++; finishPending(key, now, 'pomodoro_upgrade'); write(key, value);
    }
    return value;
  }
  function write(key, value) {
    device.run(key);
    sql('INSERT INTO screen_break_settings VALUES (?,?,?) ON CONFLICT(device_key) DO UPDATE SET settings=excluded.settings,session=excluded.session')
      .run(key, JSON.stringify(value.settings), JSON.stringify(value.session));
  }
  function publicView(value, offset, now) {
    const { command_key, command_hash, receipts, pomodoro_version, ...session } = value.session;
    return { settings: value.settings, session, timezone_offset_minutes: offset, now_local: localDisplay(now, offset),
      next_local: localDisplay(session.next_at, offset), rest_until_local: localDisplay(session.rest_until, offset) };
  }
  function finishPending(key, now, reason) {
    sql("UPDATE screen_break_events SET status='skipped',reason=?,updated_at=? WHERE device_key=? AND status='pending'").run(reason, now, key);
  }
  function add(key, kind, due, now) {
    sql("INSERT INTO screen_break_events VALUES (?,?,?,?,?,'pending','',?,?)").run(randomUUID(), key, kind, due, due + 120000, now, now);
  }
  function stop(session) {
    session.state = 'idle'; session.next_at = session.rest_until = null;
    session.paused_state = session.remaining_ms = session.rest_kind = session.rest_minutes = null;
  }
  function focus(session, settings, at, fresh = false) {
    if (fresh) session.completed_focus = session.total_focus = 0;
    else if (session.rest_kind === 'long') session.completed_focus = 0;
    session.state = 'working'; session.next_at = at + settings.interval_minutes * 60000; session.rest_until = null;
    session.rest_kind = session.rest_minutes = session.paused_state = session.remaining_ms = null;
  }
  function rest(session, settings, at, completed = false, minutes) {
    if (completed) { session.completed_focus++; session.total_focus++; }
    session.rest_kind = session.completed_focus >= settings.cycles_before_long_rest ? 'long' : 'short';
    session.rest_minutes = minutes ?? (session.rest_kind === 'long' ? settings.long_rest_minutes : settings.rest_minutes);
    session.state = 'resting'; session.rest_until = at + session.rest_minutes * 60000; session.next_at = null;
  }
  function run({ key, now, operation, input, defaultOffset }) {
    const action = operation.slice('screen_'.length), value = read(key, now, defaultOffset), settings = value.settings, session = value.session;
    const time = reminderSettings(key, defaultOffset), window = activeWindow(settings, now, time.timezone_offset_minutes);
    if (action === 'get') { object(input, []); return publicView(value, time.timezone_offset_minutes, now); }
    if (action === 'history') {
      object(input, ['limit','offset']); const limit = integer(input.limit ?? 20, 1, 50, 'limit'), offset = integer(input.offset ?? 0, 0, 1000, 'offset');
      const rows = sql('SELECT * FROM screen_break_events WHERE device_key=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(key, limit + 1, offset);
      return { events: rows.slice(0, limit).map(({ device_key, ...event }) => event), has_more: rows.length > limit, playback_acknowledgement: false };
    }
    if (action === 'update') {
      if (session.state !== 'idle' && session.window_end !== null && session.window_end <= now) stop(session);
      value.settings = normalizeSettings(input, settings); session.revision++;
      finishPending(key, now, 'settings_changed');
      if (value.settings.cycles_before_long_rest !== settings.cycles_before_long_rest) session.completed_focus = 0;
      const updatedWindow = activeWindow(value.settings, now, time.timezone_offset_minutes);
      if (!updatedWindow) stop(session);
      else {
        session.window_end = updatedWindow.end;
        if (session.state === 'working') session.next_at = now + value.settings.interval_minutes * 60000;
        if (session.state === 'resting' || session.state === 'paused' && session.paused_state === 'resting') {
          session.rest_minutes = session.rest_kind === 'long' ? value.settings.long_rest_minutes : value.settings.rest_minutes;
          if (session.state === 'resting') session.rest_until = now + session.rest_minutes * 60000;
          else session.remaining_ms = session.rest_minutes * 60000;
        } else if (session.state === 'paused') session.remaining_ms = value.settings.interval_minutes * 60000;
      }
      write(key, value); return publicView(value, time.timezone_offset_minutes, now);
    }
    if (action === 'command') {
      object(input, ['action','minutes','request_key']);
      if (!['start','stop','rest','pause','resume','snooze','skip'].includes(input.action)) throw new TypeError('Invalid Pomodoro action');
      if (input.minutes !== undefined) integer(input.minutes, 1, input.action === 'snooze' ? 240 : 60, 'minutes');
      if (input.minutes !== undefined && !['snooze','rest'].includes(input.action)) throw new TypeError('Minutes only apply to rest or snooze');
      if (input.request_key !== undefined && (typeof input.request_key !== 'string' || input.request_key.length > 128 || !input.request_key)) throw new TypeError('Invalid request key');
      const hash = fingerprint({ action: input.action, minutes: input.minutes });
      const receipt = session.receipts?.find(item => item.key === input.request_key);
      if (input.request_key && (receipt || input.request_key === session.command_key)) {
        if (hash !== (receipt?.hash ?? session.command_hash)) throw Object.assign(new Error('Command key reused with different content'), { code: 'REMINDER_CONFLICT' });
        return { ...publicView(value, time.timezone_offset_minutes, now), duplicate: true };
      }
      if (input.action !== 'stop' && !window) throw new TypeError('Outside the configured active hours/days');
      // Expired active windows cannot carry their old cycle into another day.
      if (session.state !== 'idle' && session.window_end <= now) stop(session);
      if (input.action === 'stop') {
        stop(session);
        session.last_auto_at = window?.start ?? session.last_auto_at;
        finishPending(key, now, 'user_stopped');
      } else if (input.action === 'start') {
        if (session.state !== 'working') focus(session, settings, now, true);
        session.window_end = window.end; session.last_auto_at = window.start; finishPending(key, now, 'work_resumed');
      } else if (input.action === 'resume') {
        if (session.state === 'paused') {
          session.state = session.paused_state;
          if (session.state === 'working') session.next_at = now + session.remaining_ms;
          else session.rest_until = now + session.remaining_ms;
          session.paused_state = session.remaining_ms = null;
        } else if (session.state !== 'working') focus(session, settings, now, session.state === 'idle');
        session.window_end = window.end; session.last_auto_at = window.start; finishPending(key, now, 'work_resumed');
      } else {
        if (session.state === 'idle') throw new TypeError('Start a Pomodoro session first');
        if (input.action === 'pause') {
          if (session.state !== 'paused') {
            session.paused_state = session.state;
            session.remaining_ms = Math.max(0, (session.state === 'working' ? session.next_at : session.rest_until) - now);
            session.state = 'paused'; session.next_at = session.rest_until = null;
          }
          finishPending(key, now, 'user_paused');
        } else {
          if (session.state === 'paused') throw new TypeError('Resume the paused Pomodoro first');
          if (input.action === 'rest') {
            rest(session, settings, now, false, input.minutes); finishPending(key, now, 'rest_started');
          } else if (input.action === 'snooze') {
            if (session.state !== 'working') throw new TypeError('Snooze requires a focus session');
            session.next_at = now + (input.minutes ?? 5) * 60000; finishPending(key, now, 'user_snoozed');
          } else {
            // Skipping focus does not count it as completed; skipping rest starts focus.
            if (session.state === 'working') rest(session, settings, now);
            else focus(session, settings, now);
            finishPending(key, now, 'user_skipped');
          }
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
      const reason = row.expires_at <= now ? 'expired' : !window || ['idle','paused'].includes(session.state) || session.window_end !== null && session.window_end <= now ? 'inactive' :
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
      stop(session); session.revision++; finishPending(key,now,'outside_active_hours');
    }
    if (!window) {
      if (session.state !== 'idle') { stop(session); session.revision++; }
      finishPending(key, now, 'outside_active_hours');
    } else {
      if (settings.auto_start && session.state === 'idle' && session.last_auto_at !== window.start) {
        focus(session, settings, now, true); session.window_end = window.end;
        session.last_auto_at = window.start; session.revision++;
      }
      // Advance a single elapsed phase. Long outages never fabricate completed
      // focus cycles or replay a backlog; the next phase gets its full duration.
      if (session.state === 'resting' && session.rest_until <= now) {
        const due = session.rest_until; finishPending(key, now, 'phase_changed');
        focus(session, settings, now); session.revision++; add(key, 'break_end', due, now);
      } else if (session.state === 'working' && session.next_at <= now) {
        const due = session.next_at; finishPending(key, now, 'phase_changed');
        rest(session, settings, now, true); session.revision++; add(key, 'break_due', due, now);
      }
    }
    // Avoid creating default rows for every device at every scheduler tick.
    if (sql('SELECT 1 FROM screen_break_settings WHERE device_key=?').get(key)) write(key, value);
    sql("UPDATE screen_break_events SET status='skipped',reason='expired',updated_at=? WHERE device_key=? AND status='pending' AND expires_at<=?").run(now, key, now);
    const events = sql("SELECT * FROM screen_break_events WHERE device_key=? AND status='pending' ORDER BY due_at LIMIT 2").all(key);
    return { ...publicView(value, time.timezone_offset_minutes, now), quiet: quietNow(time, now),
      events: events.map(({ device_key, ...event }) => ({ ...event, revision: session.revision, rest_minutes: session.rest_minutes ?? settings.rest_minutes, long_rest: session.rest_kind === 'long' })) };
  }
  function cleanup(now) { sql('DELETE FROM screen_break_events WHERE created_at<=?').run(now - 30 * DAY); }
  return { run, cleanup };
}
module.exports = { createScreenBreakStorage, normalizeSettings, activeWindow, DEFAULTS };
