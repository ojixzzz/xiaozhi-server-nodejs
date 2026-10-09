'use strict';

const { randomUUID } = require('node:crypto');
const { DAY, integer, nextOccurrence, previousOccurrence, occurrenceCount, localDisplay } = require('./reminder-calendar');
function createReminderExtras(db, { settings, scheduleRow, id, view, fail }) {
  const sql = query => db.prepare(query);
  function event(key, notificationId, occurrenceId, name, reason, at) {
    sql('INSERT INTO notification_events(device_key,notification_id,occurrence_id,event,reason,at) VALUES (?,?,?,?,?,?)')
      .run(key, notificationId, occurrenceId, name, reason || '', at);
    // Keep a bounded timeline even when an unread chime repeats for many days.
    if (notificationId) sql(`DELETE FROM notification_events WHERE notification_id=? AND seq NOT IN
      (SELECT seq FROM notification_events WHERE notification_id=? ORDER BY seq DESC LIMIT 100) AND event NOT IN ('stored','due','read')`).run(notificationId, notificationId);
  }
  function notificationEvent(key, notificationId, name, reason, now) {
    const row = sql('SELECT id FROM reminder_occurrences WHERE device_key=? AND notification_id=?').get(key, notificationId);
    const last = sql('SELECT event,reason FROM notification_events WHERE device_key=? AND notification_id=? ORDER BY seq DESC LIMIT 1').get(key, notificationId);
    // Repeated identical blockers retain their first timestamp, without log spam.
    if (last?.event === name && last?.reason === reason) return;
    event(key, notificationId, row?.id ?? null, name, reason, now);
  }
  function occurrenceEvents(key, reminderId, name, now) {
    for (const row of sql("SELECT id,notification_id FROM reminder_occurrences WHERE device_key=? AND reminder_id=? AND state IN ('pending','snoozed')").all(key, reminderId)) {
      event(key, row.notification_id, row.id, name, '', now);
    }
  }
  function skip(key, input, now) {
    let row, occurrence;
    if (input.occurrence_id !== undefined) {
      if (input.id !== undefined || input.due_at !== undefined) throw new TypeError('Select an occurrence ID OR a schedule ID and due_at');
      occurrence = sql('SELECT * FROM reminder_occurrences WHERE device_key=? AND id=?').get(key, id(input.occurrence_id));
      if (!occurrence) throw fail('REMINDER_NOT_FOUND', 'Occurrence not found');
      row = scheduleRow(key, occurrence.reminder_id);
    } else {
      row = scheduleRow(key, input.id);
      if (!row) throw fail('REMINDER_NOT_FOUND', 'Reminder not found');
      integer(input.due_at, 1, 8640000000000000, 'exact occurrence due_at from agenda');
      occurrence = sql('SELECT * FROM reminder_occurrences WHERE device_key=? AND reminder_id=? AND due_at=?').get(key, row.id, input.due_at);
    }
    if (row.status === 'cancelled') throw new TypeError('Schedule is cancelled');
    const due = occurrence?.due_at ?? input.due_at;
    const prior = sql('SELECT 1 FROM reminder_skips WHERE reminder_id=? AND due_at=?').get(row.id, due);
    if (prior) return { reminder: view(row), occurrence: { id: occurrence?.id, due_at: due, state: 'skipped' }, duplicate: true };
    if (occurrence && !['pending','snoozed'].includes(occurrence.state)) throw new TypeError('Only open occurrences can be skipped');
    if (!occurrence) {
      const schedule = JSON.parse(row.schedule);
      if (row.status !== 'active' || due < now || due < row.next_at || nextOccurrence(schedule, due - 1) !== due) throw new TypeError('Choose an exact upcoming occurrence from agenda');
      if (sql('SELECT count(*) AS n FROM reminder_skips WHERE device_key=? AND due_at>?').get(key, now).n >= 1000) throw fail('REMINDER_CAPACITY', 'Maximum 1000 future skipped occurrences per device');
      occurrence = { id: randomUUID(), reminder_id: row.id, due_at: due, notification_id: null };
      sql("INSERT INTO reminder_occurrences(id,reminder_id,device_key,due_at,notification_id,state,created_at) VALUES (?,?,?,?,NULL,'cancelled',?)").run(occurrence.id, row.id, key, due, now);
    }
    sql('INSERT INTO reminder_skips VALUES (?,?,?,?)').run(row.id, key, due, now);
    sql("UPDATE reminder_occurrences SET state='cancelled',snooze_until=NULL WHERE id=?").run(occurrence.id);
    if (occurrence.notification_id) sql('UPDATE notification_inbox SET read_at=coalesce(read_at,?) WHERE device_key=? AND id=?').run(now, key, occurrence.notification_id);
    event(key, occurrence.notification_id, occurrence.id, 'skipped', 'user_skipped', now);
    if (row.next_at === due) {
      const schedule = JSON.parse(row.schedule); let next = nextOccurrence(schedule, due);
      while (next !== null && sql('SELECT 1 FROM reminder_skips WHERE reminder_id=? AND due_at=?').get(row.id,next)) next = nextOccurrence(schedule,next);
      sql('UPDATE reminder_schedules SET next_at=?,status=?,updated_at=?,revision=revision+1 WHERE id=?')
        .run(next,next === null ? 'finished' : row.status,now,row.id);
    }
    return { reminder: view(scheduleRow(key,row.id)), occurrence: { id: occurrence.id, reminder_id: row.id, due_at: due, state: 'skipped' } };
  }
  function window(key, input, now, defaultOffset) {
    const offset = settings(key, defaultOffset).timezone_offset_minutes;
    const from = input.from ?? new Date(now + offset * 60000).toISOString().slice(0, 10);
    if (typeof from !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(from)) throw new TypeError('from must be YYYY-MM-DD');
    const local = Date.parse(from + 'T00:00:00Z');
    if (!Number.isFinite(local) || new Date(local).toISOString().slice(0,10) !== from || local - offset * 60000 < 0) throw new TypeError('Invalid agenda date');
    const days = integer(input.days ?? 7, 1, 42, 'agenda days (1..42)');
    return { from, start: local - offset * 60000, end: local - offset * 60000 + days * DAY, days, offset };
  }
  function agenda(key, input, now, defaultOffset, countsOnly = false) {
    const w = window(key, input, now, defaultOffset), limit = integer(input.limit ?? 20, 1, 50, 'limit'), offset = integer(input.offset ?? 0, 0, 100000, 'offset');
    const schedules = sql("SELECT * FROM reminder_schedules WHERE device_key=? AND status='active' ORDER BY id LIMIT 100").all(key);
    const stored = sql(`SELECT o.*,r.title,r.status AS schedule_status,r.schedule,n.read_at,
      EXISTS(SELECT 1 FROM reminder_skips s WHERE s.reminder_id=o.reminder_id AND s.due_at=o.due_at) AS skipped
      FROM reminder_occurrences o JOIN reminder_schedules r ON r.id=o.reminder_id LEFT JOIN notification_inbox n ON n.id=o.notification_id
      WHERE o.device_key=? AND coalesce(o.snooze_until,o.due_at)>=? AND coalesce(o.snooze_until,o.due_at)<?
      ORDER BY coalesce(o.snooze_until,o.due_at),o.id LIMIT 5001`).all(key, w.start, w.end);
    const skipped = new Set(sql('SELECT reminder_id,due_at FROM reminder_skips WHERE device_key=? AND due_at>=? AND due_at<?').all(key, w.start, w.end).map(row => `${row.reminder_id}:${row.due_at}`));
    if (countsOnly) {
      const days = Array.from({ length: w.days }, (_, index) => ({ date: new Date(w.start + index * DAY + w.offset * 60000).toISOString().slice(0,10), count: 0 }));
      for (let i = 0; i < days.length; i++) {
        const a = w.start + i * DAY, b = a + DAY - 1;
        for (const row of schedules) {
          const s = JSON.parse(row.schedule), first = nextOccurrence(s, Math.max(a, row.next_at) - 1);
          if (first !== null && first <= b) {
            days[i].count += occurrenceCount(s, first, previousOccurrence(s, b));
          }
        }
        for (const row of stored) if ((row.snooze_until ?? row.due_at) >= a && (row.snooze_until ?? row.due_at) <= b) {
          const schedule = schedules.find(s => s.id === row.reminder_id);
          // A future skipped occurrence is already counted by projection.
          if (!schedule || row.due_at < schedule.next_at || row.snooze_until !== null) days[i].count++;
        }
      }
      return { days, timezone_offset_minutes: w.offset, truncated: stored.length > 5000 };
    }
    const records = stored.slice(0,5000).map(row => ({ occurrence_id: row.id, reminder_id: row.reminder_id, title: row.title,
      due_at: row.due_at, at: row.snooze_until ?? row.due_at, state: row.skipped ? 'skipped' : row.state,
      schedule_status: row.schedule_status, read_at: row.read_at, timezone_offset_minutes: JSON.parse(row.schedule).timezone_offset_minutes }));
    const existing = new Set(records.map(row => `${row.reminder_id}:${row.due_at}`));
    const compare = (a,b) => a.record.at - b.record.at || a.record.reminder_id.localeCompare(b.record.reminder_id);
    // Merge one cursor per schedule and one history cursor. Dense minute-based
    // schedules need bounded memory regardless of the selected date range/page.
    const heap = [];
    function push(entry) {
      let i = heap.length; heap.push(entry);
      while (i > 0) { const parent = Math.floor((i-1)/2); if (compare(heap[parent],entry) <= 0) break; heap[i] = heap[parent]; i = parent; }
      heap[i] = entry;
    }
    function pop() {
      const first = heap[0], last = heap.pop();
      if (heap.length) {
        let i = 0;
        while (i*2+1 < heap.length) {
          let child = i*2+1;
          if (child+1 < heap.length && compare(heap[child+1],heap[child]) < 0) child++;
          if (compare(last,heap[child]) <= 0) break;
          heap[i] = heap[child]; i = child;
        }
        heap[i] = last;
      }
      return first;
    }
    function projected(row,s,at) {
      if (at !== null && at < w.end) push({ row,s,record: { reminder_id:row.id,title:row.title,due_at:at,at,
        state: skipped.has(`${row.id}:${at}`) ? 'skipped' : 'upcoming', schedule_status:row.status,timezone_offset_minutes:s.timezone_offset_minutes } });
    }
    records.sort((a,b) => a.at - b.at || a.reminder_id.localeCompare(b.reminder_id));
    if (records.length) push({ record:records[0],historyIndex:0 });
    for (const row of schedules) {
      const s = JSON.parse(row.schedule); projected(row,s,nextOccurrence(s,Math.max(w.start,row.next_at)-1));
    }
    const page = []; let position = 0, more = false;
    while (heap.length && !more) {
      const entry = pop(), record = entry.record;
      if (entry.row) {
        projected(entry.row,entry.s,nextOccurrence(entry.s,record.at));
        if (existing.has(`${record.reminder_id}:${record.due_at}`)) continue;
      } else if (entry.historyIndex+1 < records.length) push({ record:records[entry.historyIndex+1],historyIndex:entry.historyIndex+1 });
      if (position++ >= offset) {
        if (page.length === limit) more = true;
        else page.push(record);
      }
    }
    return { agenda: page.map(row => ({ ...row, local: localDisplay(row.at, w.offset) })),
      from: w.from, days: w.days, timezone_offset_minutes: w.offset, has_more: more, truncated: stored.length > 5000 };
  }
  function trace(key, input) {
    if ((input.occurrence_id !== undefined) === (input.notification_id !== undefined)) throw new TypeError('Select one occurrence or notification ID');
    const column = input.occurrence_id ? 'occurrence_id' : 'notification_id', selected = id(input[column]);
    const row = input.occurrence_id ? sql('SELECT id FROM reminder_occurrences WHERE device_key=? AND id=?').get(key, selected) :
      sql('SELECT id FROM notification_inbox WHERE device_key=? AND id=?').get(key, selected);
    if (!row) throw fail('REMINDER_NOT_FOUND', 'Delivery record not found');
    return { events: sql(`SELECT seq,event,reason,at FROM notification_events WHERE device_key=? AND ${column}=? ORDER BY seq LIMIT 120`).all(key, selected), playback_acknowledgement: false };
  }
  function cleanup(now) {
    sql('DELETE FROM notification_events WHERE at<=? AND occurrence_id IS NULL AND notification_id IS NULL').run(now - 30 * DAY);
    sql('DELETE FROM reminder_skips WHERE due_at<=?').run(now - 30 * DAY);
  }
  return { event, notificationEvent, occurrenceEvents, skip, agenda, trace, cleanup };
}
module.exports = { createReminderExtras };
