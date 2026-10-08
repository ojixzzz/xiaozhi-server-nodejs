'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { NotificationInbox } = require('../lib/inbox');
const { createNotificationReminders } = require('../lib/notification-reminders');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaozhi-reminders-'));
  const databasePath = path.join(directory, 'notifications.sqlite');
  let now = 1700000000000;
  let allowed = true;
  let store;
  const stores = [];
  const services = [];
  const sends = [];
  const open = () => { store = new NotificationInbox({ databasePath, now: () => now }); stores.push(store); return store; };
  open();
  function service(overrides = {}) {
    const result = createNotificationReminders({
      inbox: store, deviceIds: () => ['device'], canSend: () => allowed,
      beep: async (device, notification, attempt) => { sends.push({ device, id: notification.id, attempt }); return { status: 'published' }; },
      ...overrides
    });
    services.push(result);
    return result;
  }
  t.after(async () => {
    for (const result of services) await result.close();
    for (const inbox of stores) await inbox.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    get store() { return store; }, open, service, sends,
    advance(ms) { now += ms; },
    allow(value) { allowed = value; },
    enqueue(key) { return store.enqueue('device', { sender: 'hermes', title: `Judul ${key}`, text: `Body ${key}`, idempotencyKey: key }); }
  };
}

test('one beep per minute per device, new keys for each attempt, no extra inbox entries', async t => {
  const f = await fixture(t);
  await f.enqueue('one');
  const { notification } = await f.enqueue('two');
  const reminders = f.service();
  await reminders.tick();
  f.advance(59999);
  await reminders.tick();
  assert.equal(f.sends.length, 0);
  f.advance(1);
  await Promise.all([reminders.tick(), reminders.tick()]);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].id, notification.id);
  assert.equal(f.sends[0].attempt.reminder, true);
  f.advance(60000);
  await reminders.tick();
  assert.equal(f.sends.length, 2);
  assert.notEqual(f.sends[0].attempt.attemptId, f.sends[1].attempt.attemptId);
  assert.equal((await f.store.list('device', { unreadOnly: false })).notifications.length, 2);
  assert.equal((await f.store.list('device')).unreadCount, 2);
});

test('read, idle-session gating and approval stop reminders without discarding messages', async t => {
  const f = await fixture(t);
  const { notification } = await f.enqueue('one');
  const reminders = f.service();
  f.advance(60000);
  f.allow(false);
  await reminders.tick();
  assert.equal(f.sends.length, 0);
  f.allow(true);
  await reminders.tick();
  assert.equal(f.sends.length, 1);
  await f.store.markRead('device', notification.id);
  f.advance(60000);
  await reminders.tick();
  assert.equal(f.sends.length, 1);
  assert.ok((await f.store.get('device', notification.id)).text);
});

test('unread reminders recover after restart and use persisted timestamps', async t => {
  const f = await fixture(t);
  const { notification } = await f.enqueue('one');
  const first = f.service();
  f.advance(60000);
  await first.tick();
  await first.close();
  await f.store.close();
  f.open();
  const restarted = f.service();
  f.advance(59999);
  await restarted.tick();
  assert.equal(f.sends.length, 1);
  f.advance(1);
  await restarted.tick();
  assert.equal(f.sends.length, 2);
  await f.store.markRead('device', notification.id);
  await restarted.close();
  await f.store.close();
  f.open();
  f.advance(60000);
  await f.service().tick();
  assert.equal(f.sends.length, 2);
});

test('no publication if acknowledgment or revocation occurs during the marker write', async t => {
  const f = await fixture(t);
  await f.enqueue('one');
  const original = f.store.updateBeep.bind(f.store);
  f.store.updateBeep = async (...args) => { const result = await original(...args); f.allow(false); return result; };
  f.advance(60000);
  await f.service().tick();
  assert.equal(f.sends.length, 0);
});

test('uncertain publication is paced and a broken device does not block others', async t => {
  const f = await fixture(t);
  await f.enqueue('one');
  const errors = [];
  const reminders = f.service({
    deviceIds: () => ['broken', 'device'], onError: () => errors.push(true),
    inbox: {
      reminderCandidate: (id, interval) => { if (id === 'broken') throw new Error('storage unavailable'); return f.store.reminderCandidate(id, interval); },
      updateBeep: (...args) => f.store.updateBeep(...args)
    },
    beep: async () => { f.sends.push(true); return { status: 'unknown' }; }
  });
  f.advance(60000);
  await reminders.tick();
  assert.equal(errors.length, 1);
  assert.equal(f.sends.length, 1);
  f.advance(59999);
  await reminders.tick();
  assert.equal(f.sends.length, 1);
  assert.equal((await f.store.list('device')).unreadCount, 1);
});

test('retention expiry and disabling reminders never publish', async t => {
  const f = await fixture(t);
  await f.enqueue('one');
  f.advance(60000);
  await f.service({ intervalMs: 0 }).tick();
  assert.equal(f.sends.length, 0);
  f.advance(30 * 86400000);
  await f.service().tick();
  assert.equal(f.sends.length, 0);
  assert.equal((await f.store.list('device')).unreadCount, 0);
});
