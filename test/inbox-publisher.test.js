'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { createNotificationIngress, publicError, ADMIN_SENDER } = require('../lib/notification-ingress');

const deviceId = 'aa:bb:cc:dd:ee:ff';
const otherDevice = '11:22:33:44:55:66';
const input = { device_id: deviceId, title: 'Reminder', text: 'Meeting at ten', idempotency_key: 'dashboard:1' };
const rejection = (code, status) => error => error.code === code && error.statusCode === status;

function fakeInbox() {
  const entries = new Map();
  const calls = { enqueue: 0, get: [], update: [] };
  return {
    entries, calls,
    async enqueue(device, value) {
      calls.enqueue++;
      const key = JSON.stringify([device, value.sender, value.idempotencyKey]);
      const existing = entries.get(key);
      if (existing) {
        if (existing.title !== value.title || existing.text !== value.text) {
          throw Object.assign(new Error('Private database detail'), { code: 'INBOX_IDEMPOTENCY_CONFLICT' });
        }
        return { notification: existing, duplicate: true };
      }
      const notification = { id: randomUUID(), deviceId: device, ...value, readAt: null,
        beep: { status: 'not_published', reason: 'not_attempted' } };
      entries.set(key, notification);
      return { notification, duplicate: false };
    },
    async get(device, id) {
      calls.get.push({ device, id });
      return [...entries.values()].find(entry => entry.deviceId === device && entry.id === id) || null;
    },
    async updateBeep(device, id, value) {
      calls.update.push({ device, id, value });
      const notification = [...entries.values()].find(entry => entry.deviceId === device && entry.id === id);
      if (!notification) return null;
      notification.beep = value;
      return notification;
    }
  };
}
function fixture(options = {}) {
  const inbox = options.inbox || fakeInbox();
  const calls = [];
  const router = createNotificationIngress({ env: {}, inbox,
    resolveDevice: id => id === deviceId ? { status: 'approved' } : null,
    beep: async (device, notification, options) => { calls.push({ device, notification, options }); return { status: 'published' }; },
    ...options });
  return { inbox, calls, router };
}
async function seed(inbox, device = deviceId) {
  return (await inbox.enqueue(device, { sender: 'hermes', title: input.title, text: input.text,
    idempotencyKey: randomUUID() })).notification;
}

test('dashboard sends work without external credentials and despite invalid external configuration', async () => {
  for (const env of [{}, { NOTIFY_SENDERS_JSON: '[]' }, { NOTIFY_SENDERS_JSON: '{broken' },
    { NOTIFY_SENDERS_JSON: '[{"name":"invalid"}]' }, { NOTIFY_INGRESS_ORIGINS: 'not-an-origin' },
    { NOTIFY_INGRESS_RATE_PER_MINUTE: 'not-a-number' }]) {
    const f = fixture({ env });
    const result = await f.router.publishAdmin(input);
    assert.equal(result.stored, true);
    assert.equal(result.duplicate, false);
    assert.deepEqual(result.beep, { status: 'published', playback: 'unknown' });
    assert.equal(f.router.status().configured, false);
    assert.equal([...f.inbox.entries.values()][0].sender, '@dashboard-admin');
    assert.equal(f.calls[0].options, undefined);
  }
});

test('dashboard source cannot be claimed by an external sender or supplied in admin content', async () => {
  const token = randomBytes(32).toString('hex');
  const f = fixture({ env: { NOTIFY_SENDERS_JSON: JSON.stringify([
    { name: ADMIN_SENDER, token_env: 'TEST_SENDER_TOKEN', device_ids: [deviceId] }
  ]), TEST_SENDER_TOKEN: token } });
  assert.equal(f.router.status().configured, false);
  for (const field of ['source', 'sender', 'audio_url', 'subtitles', 'command', 'notification_id', 'confirm', 'attemptId']) {
    await assert.rejects(f.router.publishAdmin({ ...input, [field]: 'forged' }), rejection('INVALID_INPUT', 400));
  }
  assert.equal(f.inbox.entries.size, 0);
  await f.router.publishAdmin(input);
  assert.equal([...f.inbox.entries.values()][0].sender, ADMIN_SENDER);
});

test('admin publication shares validation, exact approval, durable dedupe and conflict behavior', async () => {
  let approved = true;
  const f = fixture({ resolveDevice: id => id === deviceId ? { status: approved ? 'approved' : 'pending' } : null });
  for (const device_id of [otherDevice, deviceId.toUpperCase()]) {
    await assert.rejects(f.router.publishAdmin({ ...input, device_id }), rejection('DESTINATION_NOT_ALLOWED', 403));
  }
  const first = await f.router.publishAdmin(input);
  const repeated = await f.router.publishAdmin(input);
  assert.equal(repeated.notification_id, first.notification_id);
  assert.equal(repeated.duplicate, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.inbox.entries.size, 1);
  await assert.rejects(f.router.publishAdmin({ ...input, text: 'Changed content' }), { code: 'INBOX_IDEMPOTENCY_CONFLICT' });
  approved = false;
  await assert.rejects(f.router.publishAdmin(input), rejection('DESTINATION_NOT_ALLOWED', 403));
  assert.equal(f.calls.length, 1);
});

test('admin limits are global across devices and publication/retry requests', async () => {
  const f = fixture({ env: { NOTIFY_INGRESS_RATE_PER_MINUTE: '1' }, resolveDevice: () => ({ status: 'approved' }) });
  const first = await f.router.publishAdmin(input);
  await assert.rejects(f.router.publishAdmin({ ...input, device_id: otherDevice }), rejection('SENDER_RATE_LIMITED', 429));
  await assert.rejects(f.router.retryAdminBeep(deviceId, first.notification_id,
    { attemptId: randomUUID(), confirm: true }), rejection('SENDER_RATE_LIMITED', 429));
  assert.equal(f.inbox.entries.size, 1);
  assert.equal(f.calls.length, 1);
});

test('pre-effect rate rejection allows the same retry attempt to succeed after recovery', async () => {
  let time = 100000;
  const f = fixture({ now: () => time, env: { NOTIFY_INGRESS_RATE_PER_MINUTE: '1' } });
  const first = await f.router.publishAdmin(input);
  const options = { attemptId: randomUUID(), confirm: true };
  await assert.rejects(f.router.retryAdminBeep(deviceId, first.notification_id, options), rejection('SENDER_RATE_LIMITED', 429));
  time += 60001;
  const recovered = await f.router.retryAdminBeep(deviceId, first.notification_id, options);
  assert.equal(recovered.beep.status, 'published');
  assert.equal(recovered.duplicate, false);
  assert.equal((await f.router.retryAdminBeep(deviceId, first.notification_id, options)).duplicate, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.inbox.entries.size, 1);
});

test('manual retry requires existing scoped record, explicit confirmation and strict options', async () => {
  const f = fixture();
  const notification = await seed(f.inbox);
  for (const options of [undefined, null, [], {}, { attemptId: randomUUID() }, { attemptId: randomUUID(), confirm: false },
    { attemptId: randomUUID(), confirm: 'true' }, { attemptId: '', confirm: true }, { attemptId: 'a'.repeat(129), confirm: true },
    { attemptId: 'contains space', confirm: true }, { attemptId: randomUUID(), confirm: true, text: 'injected' },
    { attemptId: randomUUID(), confirm: true, device_id: otherDevice }, { attemptId: randomUUID(), confirm: true, source: 'forged' }]) {
    await assert.rejects(f.router.retryAdminBeep(deviceId, notification.id, options), rejection('INVALID_INPUT', 400));
  }
  await assert.rejects(f.router.retryAdminBeep(deviceId, 'not-an-id', { attemptId: randomUUID(), confirm: true }), rejection('INVALID_INPUT', 400));
  await assert.rejects(f.router.retryAdminBeep(deviceId, randomUUID(), { attemptId: randomUUID(), confirm: true }), rejection('NOTIFICATION_NOT_FOUND', 404));
  await assert.rejects(f.router.retryAdminBeep(otherDevice, notification.id, { attemptId: randomUUID(), confirm: true }), rejection('NOTIFICATION_NOT_FOUND', 404));
  assert.deepEqual(f.inbox.calls.get.at(-1), { device: otherDevice, id: notification.id });
  assert.equal(f.inbox.entries.size, 1);
  assert.equal(f.inbox.calls.enqueue, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.inbox.calls.update.length, 0);
});

test('retry reuses marker/effect/result ordering while preserving id, content and read state', async () => {
  const inbox = fakeInbox();
  const notification = await seed(inbox);
  notification.readAt = '2026-10-07T07:00:00.000Z';
  notification.beep = { status: 'unknown', reason: 'publication_unconfirmed' };
  const original = { id: notification.id, title: notification.title, text: notification.text, readAt: notification.readAt };
  const attemptId = randomUUID();
  let beepCalls = 0;
  const f = fixture({ inbox, beep: async (device, record, options) => {
    beepCalls++;
    assert.equal(device, deviceId);
    assert.equal(record.id, original.id);
    assert.equal(inbox.entries.size, 1);
    assert.equal(inbox.calls.enqueue, 1);
    assert.equal(record.beep.status, 'unknown');
    assert.equal(record.beep.reason, 'retry_attempt_started');
    assert.deepEqual(options, { attemptId });
    return { status: 'published' };
  } });
  const result = await f.router.retryAdminBeep(deviceId, notification.id, { attemptId, confirm: true });
  assert.equal(result.retry, true);
  assert.equal(result.notification_id, notification.id);
  assert.equal(result.beep.status, 'published');
  assert.equal(result.beep_status_persisted, true);
  assert.deepEqual({ id: notification.id, title: notification.title, text: notification.text, readAt: notification.readAt }, original);
  assert.equal(inbox.calls.enqueue, 1);
  assert.equal(beepCalls, 1);
  assert.deepEqual(inbox.calls.update.map(call => call.value.status), ['unknown', 'published']);
});

test('same retry attempt deduplicates concurrent and completed calls without regenerating assets', async () => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let beepCalls = 0;
  const f = fixture({ env: { NOTIFY_INGRESS_MAX_PENDING: '1', NOTIFY_INGRESS_RATE_PER_MINUTE: '1' },
    beep: () => { beepCalls++; started(); return new Promise(resolve => { release = resolve; }); } });
  const notification = await seed(f.inbox);
  const options = { attemptId: randomUUID(), confirm: true };
  const first = f.router.retryAdminBeep(deviceId, notification.id, options);
  await ready;
  const second = f.router.retryAdminBeep(deviceId, notification.id, options);
  release({ status: 'published' });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.duplicate, false);
  assert.equal(b.duplicate, true);
  const third = await f.router.retryAdminBeep(deviceId, notification.id, options);
  assert.equal(third.duplicate, true);
  assert.deepEqual(third.beep, a.beep);
  assert.equal(beepCalls, 1);
  assert.equal(f.inbox.calls.get.length, 1);
  assert.equal(f.inbox.calls.update.length, 2);
  assert.equal(f.inbox.calls.enqueue, 1);
});

test('retry cache is scoped by device and notification and expires after ten minutes', async () => {
  let time = 100000;
  const f = fixture({ now: () => time, resolveDevice: () => ({ status: 'approved' }) });
  const one = await seed(f.inbox);
  const two = await seed(f.inbox, otherDevice);
  const options = { attemptId: randomUUID(), confirm: true };
  await f.router.retryAdminBeep(deviceId, one.id, options);
  await f.router.retryAdminBeep(otherDevice, two.id, options);
  time += 599999;
  assert.equal((await f.router.retryAdminBeep(deviceId, one.id, options)).duplicate, true);
  assert.equal(f.calls.length, 2);
  time++;
  assert.equal((await f.router.retryAdminBeep(deviceId, one.id, options)).duplicate, false);
  assert.equal(f.calls.length, 3);
  assert.equal(f.inbox.entries.size, 2);
});

test('retry dedupe cache stays bounded without evicting recent attempts to admit new ones', async () => {
  let time = 100000;
  const f = fixture({ now: () => time, env: { NOTIFY_INGRESS_RATE_PER_MINUTE: '600' } });
  const notification = await seed(f.inbox);
  const firstOptions = { attemptId: randomUUID(), confirm: true };
  await f.router.retryAdminBeep(deviceId, notification.id, firstOptions);
  for (let i = 1; i < 1024; i++) {
    if (i === 600) time += 60001;
    await f.router.retryAdminBeep(deviceId, notification.id, { attemptId: randomUUID(), confirm: true });
  }
  const extra = { attemptId: randomUUID(), confirm: true };
  await assert.rejects(f.router.retryAdminBeep(deviceId, notification.id, extra), rejection('RETRY_CACHE_BUSY', 429));
  assert.equal((await f.router.retryAdminBeep(deviceId, notification.id, firstOptions)).duplicate, true);
  assert.equal(f.calls.length, 1024);
  time += 600000;
  assert.equal((await f.router.retryAdminBeep(deviceId, notification.id, extra)).duplicate, false);
  assert.equal(f.calls.length, 1025);
  assert.equal(f.inbox.entries.size, 1);
});

test('revocation before or during retry marker prevents a chime; cached results also recheck approval', async () => {
  let approved = false;
  const inbox = fakeInbox();
  const notification = await seed(inbox);
  const update = inbox.updateBeep;
  const f = fixture({ inbox, resolveDevice: () => ({ status: approved ? 'approved' : 'pending' }) });
  await assert.rejects(f.router.retryAdminBeep(deviceId, notification.id,
    { attemptId: randomUUID(), confirm: true }), rejection('DESTINATION_NOT_ALLOWED', 403));
  approved = true;
  inbox.updateBeep = async (...args) => { const record = await update(...args); approved = false; return record; };
  const options = { attemptId: randomUUID(), confirm: true };
  const result = await f.router.retryAdminBeep(deviceId, notification.id, options);
  assert.equal(result.beep.status, 'not_published');
  assert.equal(notification.beep.reason, 'destination_revoked');
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.router.retryAdminBeep(deviceId, notification.id, options), rejection('DESTINATION_NOT_ALLOWED', 403));
  assert.equal(notification.readAt, null);
});

test('failed retry marker never beeps and failed result persistence retains the stored receipt', async () => {
  for (const failAt of [1, 2]) {
    const inbox = fakeInbox();
    const notification = await seed(inbox);
    const original = inbox.updateBeep;
    let updates = 0;
    inbox.updateBeep = async (...args) => { if (++updates === failAt) throw new Error('Private disk failure'); return original(...args); };
    const f = fixture({ inbox });
    const result = await f.router.retryAdminBeep(deviceId, notification.id, { attemptId: randomUUID(), confirm: true });
    assert.equal(result.stored, true);
    assert.equal(result.beep_status_persisted, false);
    assert.equal(f.calls.length, failAt === 1 ? 0 : 1);
    assert.equal(result.beep.status, failAt === 1 ? 'not_published' : 'published');
    assert.equal(inbox.entries.size, 1);
    assert.equal(notification.readAt, null);
  }
});

test('timed-out admin retry retains the global active slot and cached attempt never beeps again', async () => {
  let time = 100000;
  let release;
  let calls = 0;
  const f = fixture({ now: () => time,
    env: { NOTIFY_INGRESS_MAX_PENDING: '1', NOTIFY_INGRESS_BEEP_TIMEOUT_MS: '1000' },
    beep: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const notification = await seed(f.inbox);
  const options = { attemptId: randomUUID(), confirm: true };
  const first = await f.router.retryAdminBeep(deviceId, notification.id, options);
  assert.equal(first.beep.status, 'unknown');
  time += 60001;
  assert.equal((await f.router.retryAdminBeep(deviceId, notification.id, options)).duplicate, true);
  await assert.rejects(f.router.publishAdmin(input), rejection('SENDER_BUSY', 429));
  const blockedAttempt = { attemptId: randomUUID(), confirm: true };
  await assert.rejects(f.router.retryAdminBeep(deviceId, notification.id, blockedAttempt), rejection('SENDER_BUSY', 429));
  assert.equal(calls, 1);
  release({ status: 'published' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notification.beep.status, 'unknown');
  assert.equal((await f.router.retryAdminBeep(deviceId, notification.id, options)).beep.status, 'unknown');
  assert.equal(calls, 1);
  const recovery = f.router.retryAdminBeep(deviceId, notification.id, blockedAttempt);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  release({ status: 'published' });
  assert.equal((await recovery).beep.status, 'published');
  assert.equal(f.inbox.entries.size, 1);
});

test('admin error mapper preserves uncertain commit status and does not leak internal details', async () => {
  const f = fixture();
  assert.equal(f.router.publicError, publicError);
  const unavailable = publicError(new Error('Private filesystem path'));
  assert.equal(unavailable.stored, null);
  assert.equal(unavailable.status, 503);
  assert.ok(!JSON.stringify(unavailable).includes('Private'));
  const conflict = publicError(Object.assign(new Error('Private detail'), { code: 'INBOX_IDEMPOTENCY_CONFLICT' }));
  assert.equal(conflict.status, 409);
  assert.equal(conflict.stored, false);
});

test('dashboard publication survives SQLite reopen and an explicit retry preserves the same read record', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { NotificationInbox } = require('../lib/inbox');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaozhi-admin-publish-'));
  const databasePath = path.join(root, 'notifications.sqlite');
  const stores = [];
  t.after(async () => { for (const store of stores) await store.close(); await fs.rm(root, { recursive: true, force: true }); });
  const original = new NotificationInbox({ databasePath });
  stores.push(original);
  const first = fixture({ inbox: original });
  const receipt = await first.router.publishAdmin(input);
  await original.markRead(deviceId, receipt.notification_id);
  const before = await original.get(deviceId, receipt.notification_id);
  await original.close();
  const reopened = new NotificationInbox({ databasePath });
  stores.push(reopened);
  const second = fixture({ inbox: reopened });
  const duplicate = await second.router.publishAdmin(input);
  assert.equal(duplicate.notification_id, receipt.notification_id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(second.calls.length, 0);
  const options = { attemptId: randomUUID(), confirm: true };
  await second.router.retryAdminBeep(deviceId, receipt.notification_id, options);
  await second.router.retryAdminBeep(deviceId, receipt.notification_id, options);
  assert.equal(second.calls.length, 1);
  const after = await reopened.get(deviceId, receipt.notification_id);
  assert.equal(after.readAt, before.readAt);
  assert.equal(after.id, before.id);
  assert.equal(after.sender, ADMIN_SENDER);
  assert.equal(after.text, before.text);
  assert.equal((await reopened.list(deviceId, { unreadOnly: false })).notifications.length, 1);
});
