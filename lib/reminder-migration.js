'use strict';

// Version 3 only adds tables, preserving the v1/v2 inbox and reminder records.
function migrateProductivity(db) {
  db.exec(`
    CREATE TABLE reminder_skips (
      reminder_id TEXT NOT NULL REFERENCES reminder_schedules(id) ON DELETE CASCADE,
      device_key TEXT NOT NULL REFERENCES notification_devices(device_key) ON DELETE CASCADE,
      due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(reminder_id,due_at)
    ) STRICT;
    CREATE INDEX reminder_skip_device ON reminder_skips(device_key,due_at);
    CREATE TABLE notification_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      device_key TEXT NOT NULL REFERENCES notification_devices(device_key) ON DELETE CASCADE,
      notification_id TEXT REFERENCES notification_inbox(id) ON DELETE CASCADE,
      occurrence_id TEXT REFERENCES reminder_occurrences(id) ON DELETE CASCADE,
      event TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX notification_event_device ON notification_events(device_key,notification_id,seq);
    CREATE INDEX notification_event_occurrence ON notification_events(device_key,occurrence_id,seq);
    CREATE TABLE screen_break_settings (
      device_key TEXT PRIMARY KEY REFERENCES notification_devices(device_key) ON DELETE CASCADE,
      settings TEXT NOT NULL CHECK(json_valid(settings)), session TEXT NOT NULL CHECK(json_valid(session))
    ) STRICT;
    CREATE TABLE screen_break_events (
      id TEXT PRIMARY KEY, device_key TEXT NOT NULL REFERENCES notification_devices(device_key) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('break_due','break_end')), due_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','claimed','published','skipped','unknown')),
      reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX screen_event_device ON screen_break_events(device_key,due_at);
    INSERT INTO notification_events(device_key,notification_id,event,reason,at)
      SELECT device_key,id,'stored','legacy_snapshot',created_at FROM notification_inbox;
    INSERT INTO notification_events(device_key,notification_id,event,reason,at)
      SELECT device_key,id,CASE beep_status WHEN 'published' THEN 'beep_published' WHEN 'unknown' THEN 'beep_unknown' ELSE 'beep_deferred' END,
        'legacy_snapshot',beep_updated_at FROM notification_inbox WHERE beep_updated_at IS NOT NULL;
    INSERT INTO notification_events(device_key,notification_id,event,reason,at)
      SELECT device_key,id,'read','legacy_snapshot',read_at FROM notification_inbox WHERE read_at IS NOT NULL;
    UPDATE notification_events SET occurrence_id=(SELECT id FROM reminder_occurrences WHERE notification_id=notification_events.notification_id);
    PRAGMA user_version=3;
  `);
}
module.exports = { migrateProductivity };
