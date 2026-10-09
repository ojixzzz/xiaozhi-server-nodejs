'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { NotificationInbox } = require('../lib/inbox');
const { createReminderService } = require('../lib/reminders');
const { createReminderTools, REMINDER_TOOLS } = require('../lib/reminder-tools');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaozhi-reminders-'));
  const filename = path.join(directory, 'notifications.sqlite');
  let now = Date.parse('2026-10-09T00:00:00Z');
  let store = new NotificationInbox({ databasePath: filename, now: () => now, ...options });
  t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get store() { return store; }, filename, advance(ms) { now += ms; }, setNow(value) { now = value; },
    call(action, input = {}, device = 'a') { return store.reminders(device, action, input, 420); },
    async reopen() { await store.close(); store = new NotificationInbox({ databasePath: filename, now: () => now, ...options }); },
    sql(fn) { const db = new DatabaseSync(filename); try { return fn(db); } finally { db.close(); } }
  };
}
const input = (schedule = { kind: 'once', after_seconds: 300 }) => ({ title: 'Minum', text: 'Minum air.', schedule });

test('one reminder request survives restart and yields exactly one durable inbox message', async t => {
  const f = fixture(t);
  const args = { ...input(), request_key: 'same-request' };
  const first = await f.call('create', args);
  f.advance(1000);
  assert.equal((await f.call('create', args)).reminder.id, first.reminder.id);
  assert.equal((await f.store.list('a')).unreadCount, 0, 'creation does not send a second acknowledgment');
  await f.reopen(); f.advance(299000);
  const tick = await f.call('tick');
  assert.equal(tick.notifications.length, 1);
  assert.equal(tick.notifications[0].title, 'Minum');
  await f.reopen();
  assert.equal((await f.call('tick')).notifications.length, 0);
  assert.equal((await f.store.list('a')).unreadCount, 1);
  assert.equal((await f.call('create', args)).duplicate, true);
  await assert.rejects(f.call('create', { ...args, title: 'Different' }), { code: 'REMINDER_CONFLICT' });
});

test('a failed occurrence insert rolls back its inbox insert and schedule advance', async t => {
  const f = fixture(t);
  const created = await f.call('create', input()); f.advance(300000);
  f.sql(db => db.exec("CREATE TRIGGER fail_occurrence BEFORE INSERT ON reminder_occurrences BEGIN SELECT RAISE(ABORT,'test failure'); END"));
  await assert.rejects(f.call('tick'));
  assert.equal((await f.store.list('a')).unreadCount, 0);
  assert.equal((await f.call('get', { id: created.reminder.id })).reminder.next_at, created.reminder.next_at);
  f.sql(db => db.exec('DROP TRIGGER fail_occurrence'));
  await f.reopen();
  assert.equal((await f.call('tick')).notifications.length, 1);
});

test('read, done, and snooze are separate; snooze reuses the exact notification and keeps recurrence anchored', async t => {
  const f = fixture(t);
  const created = await f.call('create', input({ kind: 'interval', every_seconds: 3600 }));
  f.advance(3600000); const tick = await f.call('tick');
  const before = await f.call('get', { id: created.reminder.id }), occurrence = before.occurrences[0];
  await f.store.markRead('a', tick.notifications[0].id);
  assert.equal((await f.call('get', { id: created.reminder.id })).occurrences[0].state, 'pending');
  const args = { occurrence_id: occurrence.id, seconds: 600, request_key: 'snooze-1' };
  const snooze = await f.call('snooze', args); f.advance(10000);
  assert.equal((await f.call('snooze', args)).occurrence.snooze_until, snooze.occurrence.snooze_until);
  assert.equal((await f.call('can_beep', { notification_id: occurrence.notification_id })).allowed, false);
  assert.equal((await f.call('get', { id: created.reminder.id })).reminder.next_at, before.reminder.next_at);
  await f.reopen(); f.advance(590000);
  const due = await f.call('tick');
  assert.equal(due.notifications[0].id, occurrence.notification_id);
  assert.equal((await f.store.list('a')).unreadCount, 1);
  await f.call('complete', { occurrence_id: occurrence.id });
  const completed = (await f.call('get', { id: created.reminder.id })).occurrences[0];
  assert.equal(completed.state, 'completed'); assert.ok(completed.completed_at);
  assert.equal((await f.store.list('a')).unreadCount, 0);
  assert.equal((await f.call('get', { id: created.reminder.id })).reminder.status, 'active');
});

test('missed recurring events coalesce, pause has no backlog and cancellation silences open events', async t => {
  const f = fixture(t);
  const created = await f.call('create', input({ kind: 'interval', every_seconds: 3600 }));
  f.advance(4 * 3600000 + 1000);
  assert.equal((await f.call('tick')).notifications.length, 1);
  const past = await f.call('get', { id: created.reminder.id });
  assert.equal(past.occurrences[0].skipped_count, 3);
  await f.call('update', { id: created.reminder.id, status: 'paused' });
  assert.equal((await f.call('can_beep', { notification_id: past.occurrences[0].notification_id })).allowed, false);
  f.advance(5 * 3600000);
  assert.equal((await f.call('tick')).notifications.length, 0);
  await f.call('update', { id: created.reminder.id, status: 'active' });
  assert.equal((await f.call('tick')).notifications.length, 0);
  await f.call('cancel', { id: created.reminder.id });
  assert.equal((await f.store.list('a')).unreadCount, 0);
  assert.equal((await f.call('get', { id: created.reminder.id })).occurrences[0].state, 'cancelled');
});

test('timezone defaults are snapshotted, quiet hours apply equally to external and internal messages', async t => {
  const f = fixture(t);
  const created = await f.call('create', input({ kind: 'daily', time: '08:00' }));
  await f.call('settings_update', { timezone_offset_minutes: 540, quiet_enabled: true, quiet_start: '22:00', quiet_end: '07:00' });
  assert.equal((await f.call('get', { id: created.reminder.id })).reminder.schedule.timezone_offset_minutes, 420);
  const other = await f.call('create', input({ kind: 'daily', time: '08:00' }));
  assert.equal(other.reminder.schedule.timezone_offset_minutes, 540);
  const { notification } = await f.store.enqueue('a', { sender: 'external-agent', title: 'Result', text: 'External message', idempotencyKey: 'ext1' });
  f.setNow(Date.parse('2026-10-09T13:00:00Z')); // 22:00 WIT
  const tick = await f.call('tick');
  for (const message of [notification, ...tick.notifications]) assert.equal((await f.call('can_beep', { notification_id: message.id })).reason, 'quiet_hours');
  f.setNow(Date.parse('2026-10-09T22:00:00Z')); // 07:00 WIT
  assert.equal((await f.call('can_beep', { notification_id: notification.id })).allowed, true);
  await f.reopen(); assert.equal((await f.call('settings_get')).quiet_enabled, true);
});

test('device scope, capacity, retention cleanup and device deletion preserve future schedules correctly', async t => {
  const f = fixture(t, { maxPerDevice: 1 });
  const created = await f.call('create', input());
  await assert.rejects(f.call('get', { id: created.reminder.id }, 'b'), { code: 'REMINDER_NOT_FOUND' });
  await f.store.enqueue('a', { sender: 'other', text: 'occupy inbox' }); f.advance(300000);
  assert.equal((await f.call('tick')).deferred.length, 1);
  assert.equal((await f.call('get', { id: created.reminder.id })).reminder.status, 'active');
  await f.store.cleanup();
  assert.equal((await f.call('get', { id: created.reminder.id })).reminder.id, created.reminder.id);
  f.advance(31 * 86400000);
  assert.equal((await f.call('tick')).notifications.length, 1);
  await f.call('settings_update', { quiet_enabled: true });
  const future = await f.call('create', input({ kind: 'daily', time: '08:00' }), 'b');
  await f.store.clear('a');
  assert.equal((await f.call('list')).reminders.length, 0);
  assert.equal((await f.call('history')).occurrences.length, 0);
  assert.equal((await f.call('settings_get')).quiet_enabled, false);
  assert.equal((await f.call('get', { id: future.reminder.id }, 'b')).reminder.id, future.reminder.id);
});

test('v1 inbox migrations preserve old text, read state and future settings across cleanup', async t => {
  const f = fixture(t);
  const { notification } = await f.store.enqueue('a', { sender: 'legacy', title: 'Old', text: 'Keep my text', idempotencyKey: 'legacy' });
  await f.store.markRead('a', notification.id); await f.store.close();
  f.sql(db => db.exec('DROP TABLE reminder_occurrences; DROP TABLE reminder_schedules; DROP TABLE reminder_settings; PRAGMA user_version=1;'));
  await f.reopen();
  const old = await f.store.get('a', notification.id);
  assert.equal(old.text, 'Keep my text'); assert.ok(old.readAt);
  await f.call('settings_update', { quiet_enabled: true }); await f.store.cleanup();
  assert.equal((await f.call('settings_get')).quiet_enabled, true);
  assert.equal(f.sql(db => db.prepare('PRAGMA user_version').get().user_version), 2);
});

test('voice tool requests with different call IDs share one action until the user makes another request', async t => {
  const f = fixture(t);
  let scope = 'session:1', approved = true;
  const service = createReminderService({ inbox: f.store, deviceIds: () => ['a'], allowed: () => approved, beep: async () => ({ status: 'not_published' }) });
  const run = createReminderTools({ service, deviceId: 'a', allowed: () => approved, requestScope: () => scope });
  const args = input();
  const [a,b] = await Promise.all([run('reminders_create', args), run('reminders_create', args)]);
  assert.equal(a.reminder.id, b.reminder.id);
  scope = 'session:2';
  assert.notEqual((await run('reminders_create', args)).reminder.id, a.reminder.id);
  await assert.rejects(run('reminders_create', { ...args, device_id: 'b' }), TypeError);
  approved = false; await assert.rejects(run('reminders_list', {}), TypeError);
  assert.equal(REMINDER_TOOLS.length, 8);
});

test('schedule limits, revisions and content validation reject writes without altering existing schedules', async t => {
  const f = fixture(t);
  const created = await f.call('create', input());
  await f.call('update', { id: created.reminder.id, title: 'Judul baru', revision: 1 });
  await assert.rejects(f.call('update', { id: created.reminder.id, title: 'Stale', revision: 1 }), { code: 'REMINDER_CONFLICT' });
  for (let i = 1; i < 100; i++) await f.call('create', { ...input(), title: 'Schedule ' + i });
  await assert.rejects(f.call('create', input()), { code: 'REMINDER_CAPACITY' });
  await f.call('cancel', { id: created.reminder.id });
  assert.equal((await f.call('create', input())).reminder.status, 'active');
  await assert.rejects(f.call('create', { ...input(), title: 'x'.repeat(121) }), TypeError);
  await assert.rejects(f.call('create', { ...input(), text: 'x'.repeat(2001) }), TypeError);
  await assert.rejects(f.call('settings_update', { quiet_start: '22:00', quiet_end: '22:00' }), TypeError);
});

test('scheduler retains offline notifications, skips revoked devices and honors shutdown', async t => {
  const f = fixture(t);
  let allowed = true, calls = 0;
  const service = createReminderService({ inbox: f.store, deviceIds: () => ['a'], allowed: () => allowed,
    beep: async () => { calls++; return { status: 'not_published', reason: 'offline' }; } });
  await service.call('a', 'create', input());
  allowed = false; f.advance(300000); await service.tick();
  assert.equal(calls, 0); assert.equal((await f.store.list('a')).unreadCount, 0);
  allowed = true; await service.tick(); await service.tick();
  assert.equal(calls, 1); assert.equal((await f.store.list('a')).unreadCount, 1);
  await service.close(); f.advance(300000); await service.tick();
  assert.equal(calls, 1);
});

test('automatic beep claims serialize scheduler/unread loops and persist across restart', async t => {
  const f = fixture(t);
  const { notification } = await f.store.enqueue('a', { sender: 'external', title: 'Message', text: 'Text' });
  const args = { notification_id: notification.id, interval_ms: 60000 };
  const claims = await Promise.all([f.call('claim_beep', args), f.call('claim_beep', args)]);
  assert.equal(claims.filter(row => row.allowed).length, 1);
  await f.reopen();
  assert.equal((await f.call('claim_beep', args)).reason, 'beep_interval');
  f.advance(60000);
  assert.equal((await f.call('claim_beep', args)).allowed, true);
});

test('a small tool budget preserves the committed reminder identity instead of claiming failure', async t => {
  const f = fixture(t);
  const service = createReminderService({ inbox: f.store, deviceIds: () => ['a'], allowed: () => true, beep: async () => ({ status: 'not_published' }) });
  const run = createReminderTools({ service, deviceId: 'a', allowed: () => true, requestScope: () => 'request', maxChars: 512 });
  const result = await run('reminders_create', { ...input(), title: '"'.repeat(120), text: '"'.repeat(2000) });
  assert.ok(result.reminder.id); assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length <= 512);
  assert.equal((await f.call('get', { id: result.reminder.id })).reminder.text.length, 2000);
});
