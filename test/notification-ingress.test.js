'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const express = require('express');
const { createNotificationIngress, PROTOCOL_VERSIONS } = require('../lib/notification-ingress');

const deviceId = 'aa:bb:cc:dd:ee:ff';
const otherDevice = '11:22:33:44:55:66';
const token = randomBytes(32).toString('hex');
const secondToken = randomBytes(32).toString('hex');
const payload = { device_id: deviceId, title: '提醒', text: '明天十点开会', idempotency_key: 'event:1' };
const senderRows = [{ name: 'hermes', token_env: 'HERMES_NOTIFY_TOKEN', device_ids: [deviceId] }];
const environment = () => ({ NOTIFY_SENDERS_JSON: JSON.stringify(senderRows), HERMES_NOTIFY_TOKEN: token });

function fakeInbox() {
  const entries = new Map();
  return {
    entries,
    async enqueue(device, input) {
      const key = `${device}|${input.sender}|${input.idempotencyKey}`;
      const previous = entries.get(key);
      if (previous) {
        if (previous.title !== input.title || previous.text !== input.text) {
          throw Object.assign(new Error('Private input must not leak'), { code: 'INBOX_IDEMPOTENCY_CONFLICT' });
        }
        return { notification: previous, duplicate: true };
      }
      const notification = { id: randomUUID(), ...input, deviceId: device, readAt: null, beep: { status: 'not_published', reason: 'not_attempted' } };
      entries.set(key, notification);
      return { notification, duplicate: false };
    },
    async updateBeep(device, id, status) {
      const entry = [...entries.values()].find(value => value.deviceId === device && value.id === id);
      if (!entry) return null;
      entry.beep = status;
      return entry;
    }
  };
}
async function fixture(t, options = {}) {
  const inbox = options.inbox || fakeInbox();
  const calls = [];
  const router = createNotificationIngress({ env: environment(), inbox,
    resolveDevice: id => id === deviceId ? { status: 'approved' } : null,
    beep: async (id, notification) => { calls.push({ id, notification }); return { status: 'published' }; },
    ...options });
  const app = express();
  app.use(router);
  app.use((req, res) => res.status(404).json({ otherRoute: true }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  async function request(body = payload, options = {}) {
    const response = await fetch(url + (options.path || '/api/notifications'), {
      method: options.method || 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options.headers },
      ...(options.method && options.method !== 'POST' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
    });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, body: raw ? JSON.parse(raw) : null };
  }
  const mcp = (body, options = {}) => request(body, { path: '/mcp/notifications', ...options, headers: {
    Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSIONS[0], ...options.headers
  } });
  return { inbox, calls, router, request, mcp };
}
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const toolCall = (arguments_ = payload, name = 'notify_send') => rpc('tools/call', { name, arguments: arguments_ });

test('disabled and invalid sender configurations fail closed without preventing unrelated routes', async t => {
  const disabled = await fixture(t, { env: {} });
  assert.equal(disabled.router.status().enabled, false);
  assert.equal((await disabled.request()).status, 404);
  for (const env of [
    { NOTIFY_SENDERS_JSON: '{broken' },
    { ...environment(), HERMES_NOTIFY_TOKEN: 'short' },
    { ...environment(), HERMES_NOTIFY_TOKEN: 'replace_me_with_a_long_secret_value' },
    { ...environment(), MQTT_GATEWAY_KEY: token },
    { ...environment(), NOTIFY_SENDERS_JSON: JSON.stringify([...senderRows, { ...senderRows[0], name: 'second' }]) },
    { ...environment(), NOTIFY_SENDERS_JSON: JSON.stringify([{ ...senderRows[0], device_ids: ['*'] }]) },
    { ...environment(), NOTIFY_SENDERS_JSON: JSON.stringify([{ ...senderRows[0], token: token }]) },
    { ...environment(), NOTIFY_INGRESS_ORIGINS: 'https://trusted.test/path' }
  ]) {
    const value = await fixture(t, { env });
    assert.equal(value.router.status().configured, false);
    const result = await value.request();
    assert.equal(result.status, 503);
    assert.ok(!JSON.stringify(result).includes(token));
    assert.equal((await value.request({}, { path: '/other' })).body.otherRoute, true);
  }
});

test('only configured bearer credentials authenticate; cookies, query credentials and client sender names cannot substitute', async t => {
  const f = await fixture(t);
  for (const headers of [{ Authorization: '' }, { Authorization: `Basic ${token}` }, { Authorization: `Bearer ${secondToken}` },
    { Authorization: '', Cookie: 'admin_session=valid' }]) {
    const response = await f.request(payload, { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer realm="notification-ingress"');
  }
  assert.equal((await f.request(payload, { path: `/api/notifications?token=${token}`, headers: { Authorization: '' } })).status, 401);
  for (const field of ['sender', 'source', 'client_id', 'audio_url', 'subtitles', 'command']) {
    assert.equal((await f.request({ ...payload, [field]: 'invented' })).status, 400);
  }
  assert.equal(f.inbox.entries.size, 0);
});

test('origins are rejected by default, explicit exact origins work, and no CORS is granted', async t => {
  const f = await fixture(t);
  assert.equal((await f.request(payload, { headers: { Origin: 'https://site.test' } })).status, 403);
  const allowed = await fixture(t, { env: { ...environment(), NOTIFY_INGRESS_ORIGINS: 'https://site.test' } });
  for (const origin of ['null', 'https://site.test.evil.test', 'https://site.test/', 'https://site.test:444']) {
    assert.equal((await allowed.request(payload, { headers: { Origin: origin } })).status, 403);
  }
  const good = await allowed.request(payload, { headers: { Origin: 'https://site.test' } });
  assert.equal(good.status, 201);
  assert.equal(good.headers.get('access-control-allow-origin'), null);
  assert.equal(good.headers.get('cache-control'), 'no-store');
});

test('exact allowed approved device is checked on every call including idempotent retries', async t => {
  let approved = true;
  const f = await fixture(t, { resolveDevice: () => ({ status: approved ? 'approved' : 'pending' }) });
  assert.equal((await f.request({ ...payload, device_id: otherDevice })).status, 403);
  assert.equal((await f.request({ ...payload, device_id: deviceId.toUpperCase() })).status, 403);
  assert.equal((await f.request()).status, 201);
  approved = false;
  assert.equal((await f.request()).status, 403);
  assert.equal(f.calls.length, 1);
});

test('stores before beep, derives sender, returns bounded receipt and never re-beeps duplicate content', async t => {
  const inbox = fakeInbox();
  let calls = 0;
  const f = await fixture(t, { inbox, beep: async (id, notification) => {
    calls++;
    assert.equal(id, deviceId);
    assert.equal(inbox.entries.size, 1);
    assert.equal(notification.sender, 'hermes');
    assert.equal(notification.readAt, null);
    assert.equal([...inbox.entries.values()][0].beep.status, 'unknown');
    return { status: 'published' };
  } });
  const first = await f.request();
  assert.equal(first.status, 201);
  assert.equal(first.body.stored, true);
  assert.deepEqual(first.body.beep, { status: 'published', playback: 'unknown' });
  assert.equal(first.body.beep_status_persisted, true);
  assert.ok(!JSON.stringify(first.body).includes(payload.text));
  const duplicate = await f.request();
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.notification_id, first.body.notification_id);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(calls, 1);
  const conflict = await f.request({ ...payload, text: 'Changed content' });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'INBOX_IDEMPOTENCY_CONFLICT');
  assert.ok(!JSON.stringify(conflict).includes('Private input'));
});

test('offline, busy and ambiguous beep outcomes all leave unread text stored', async t => {
  for (const beep of [async () => ({ status: 'not_published' }), async () => ({ status: 'unknown' }),
    async () => { throw new Error('secret provider internals'); }, async () => ({ status: 'played' })]) {
    const f = await fixture(t, { beep });
    const result = await f.request();
    assert.equal(result.status, 201);
    assert.equal(result.body.stored, true);
    assert.ok(['not_published', 'unknown'].includes(result.body.beep.status));
    assert.equal([...f.inbox.entries.values()][0].readAt, null);
    assert.equal([...f.inbox.entries.values()][0].text, payload.text);
    assert.ok(!JSON.stringify(result).includes('secret provider'));
  }
});

test('failed beep status persistence does not erase stored receipt or pretend a chime completed', async t => {
  for (const failAt of [1, 2]) {
    const inbox = fakeInbox();
    const original = inbox.updateBeep;
    let updates = 0;
    inbox.updateBeep = async (...args) => { if (++updates === failAt) throw new Error('disk error'); return original(...args); };
    const f = await fixture(t, { inbox });
    const result = await f.request();
    assert.equal(result.body.stored, true);
    assert.equal(result.body.beep_status_persisted, false);
    assert.equal(f.calls.length, failAt === 1 ? 0 : 1);
    assert.equal(result.body.beep.status, failAt === 1 ? 'not_published' : 'published');
  }
});

test('validates bounded text, titles, keys, MIME type, JSON syntax and parser byte limit', async t => {
  const f = await fixture(t);
  for (const input of [{ ...payload, text: '' }, { ...payload, text: 'a'.repeat(2001) }, { ...payload, title: 'a'.repeat(121) },
    { ...payload, idempotency_key: undefined }, { ...payload, idempotency_key: 'x'.repeat(129) },
    { ...payload, idempotency_key: 'contains space' }, { ...payload, text: '\u0000' }, { ...payload, text: '\ud800' }, { ...payload, title: '\n' }, [], null]) {
    assert.equal((await f.request(input)).status, 400);
  }
  assert.equal((await f.request(payload, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.request('{')).status, 400);
  assert.equal((await f.request({ ...payload, text: 'x'.repeat(18000) })).status, 413);
  assert.equal(f.inbox.entries.size, 0);
});

test('sender-specific rate and pending limits do not consume another sender allowance', async t => {
  const env = { ...environment(), OTHER_TOKEN: secondToken,
    NOTIFY_SENDERS_JSON: JSON.stringify([...senderRows, { name: 'other', token_env: 'OTHER_TOKEN', device_ids: [deviceId] }]),
    NOTIFY_INGRESS_RATE_PER_MINUTE: '1', NOTIFY_INGRESS_MAX_PENDING: '1' };
  const f = await fixture(t, { env });
  assert.equal((await f.request()).status, 201);
  assert.equal((await f.request({ ...payload, idempotency_key: 'event:2' })).status, 429);
  assert.equal((await f.request(payload, { headers: { Authorization: `Bearer ${secondToken}` } })).status, 201);
  assert.equal(f.inbox.entries.size, 2);
  let release; let called;
  const started = new Promise(resolve => { called = resolve; });
  const busy = await fixture(t, { env: { ...environment(), NOTIFY_INGRESS_MAX_PENDING: '1' },
    beep: () => { called(); return new Promise(resolve => { release = resolve; }); } });
  const pending = busy.request();
  await started;
  const result = await busy.request({ ...payload, idempotency_key: 'event:2' });
  assert.equal(result.status, 429);
  assert.equal(result.body.error.code, 'SENDER_BUSY');
  release({ status: 'not_published' });
  assert.equal((await pending).body.stored, true);
});

test('bounded callback timeout reports unknown, persists unread record, and duplicate never retries', async t => {
  let calls = 0;
  const f = await fixture(t, { env: { ...environment(), NOTIFY_INGRESS_BEEP_TIMEOUT_MS: '1000' }, beep: () => { calls++; return new Promise(() => {}); } });
  const result = await f.request();
  assert.equal(result.body.stored, true);
  assert.equal(result.body.beep.status, 'unknown');
  assert.equal((await f.request()).body.duplicate, true);
  assert.equal(calls, 1);
});

test('MCP initialize, initialized, tools/list and tools/call implement JSON Streamable HTTP', async t => {
  const f = await fixture(t);
  for (const protocolVersion of [...PROTOCOL_VERSIONS, '2024-11-05']) {
    const response = await f.mcp(rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } }),
      { headers: { 'MCP-Protocol-Version': '' } });
    // An explicitly unsupported HTTP version is rejected even on initialize.
    assert.equal(response.status, 400);
    const init = await f.request(rpc('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1' } }),
      { path: '/mcp/notifications', headers: { Accept: 'application/json, text/event-stream' } });
    assert.equal(init.status, 200);
    assert.equal(init.body.result.protocolVersion, PROTOCOL_VERSIONS.includes(protocolVersion) ? protocolVersion : PROTOCOL_VERSIONS[0]);
    assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
    assert.equal(init.headers.get('mcp-session-id'), null);
  }
  const ready = await f.mcp({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(ready.status, 202);
  assert.equal(ready.body, null);
  const list = await f.mcp(rpc('tools/list'));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.result.tools.map(tool => tool.name), ['notify_send']);
  assert.equal(list.body.result.tools[0].inputSchema.additionalProperties, false);
  assert.deepEqual(list.body.result.tools[0].outputSchema.required, ['stored']);
  const call = await f.mcp(toolCall());
  assert.equal(call.status, 200);
  assert.equal(call.body.result.isError, false);
  assert.equal(call.body.result.structuredContent.stored, true);
  assert.deepEqual(JSON.parse(call.body.result.content[0].text), call.body.result.structuredContent);
  assert.equal((await f.mcp(toolCall())).body.result.structuredContent.duplicate, true);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.mcp(rpc('ping'))).status, 200);
});

test('MCP enforces auth, Origin, Accept, Content-Type, protocol versions, and no SSE', async t => {
  const f = await fixture(t);
  assert.equal((await f.mcp(rpc('tools/list'), { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.mcp(rpc('tools/list'), { headers: { Origin: 'https://evil.test' } })).status, 403);
  for (const Accept of ['', '*/*', 'application/json', 'text/event-stream', 'application/json;q=0, text/event-stream']) {
    assert.equal((await f.mcp(rpc('tools/list'), { headers: { Accept } })).status, 406);
  }
  assert.equal((await f.mcp(rpc('tools/list'), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await f.mcp(rpc('tools/list'), { headers: { 'MCP-Protocol-Version': '2020-01-01' } })).status, 400);
  assert.equal((await f.request(rpc('tools/list'), { path: '/mcp/notifications', headers: { Accept: 'application/json,text/event-stream' } })).status, 400);
  const get = await f.mcp(null, { method: 'GET' });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await f.mcp(null, { method: 'DELETE' })).status, 405);
});

test('MCP rejects malformed protocol/unknown tools and returns isError for notify_send validation or permission failure', async t => {
  const f = await fixture(t);
  for (const body of [[rpc('tools/list')], { ...rpc('tools/list'), id: null }, { ...rpc('tools/list'), id: {} },
    { ...rpc('tools/list'), jsonrpc: '1.0' }, { ...rpc('tools/list'), params: [] }]) {
    const result = await f.mcp(body);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, -32600);
  }
  assert.equal((await f.mcp('{')).body.error.code, -32700);
  assert.equal((await f.mcp(rpc('shell/execute', {}))).body.error.code, -32601);
  assert.equal((await f.mcp(toolCall(payload, 'notifications_read'))).body.error.code, -32602);
  assert.equal((await f.mcp({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'notify_send', arguments: payload } })).status, 400);
  for (const input of [{ ...payload, text: '' }, { ...payload, device_id: otherDevice }, { ...payload, sender: 'forged' }]) {
    const response = await f.mcp(toolCall(input));
    assert.equal(response.status, 200);
    assert.equal(response.body.result.isError, true);
    assert.equal(response.body.result.structuredContent.stored, false);
  }
  assert.equal(f.inbox.entries.size, 0);
});

test('rejects reuse of admin, device, provider or transport credentials as sender credentials', async t => {
  for (const name of ['MQTT_SIGNATURE_KEY', 'MQTT_GATEWAY_KEY', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'CLIENT_AUTH_TOKEN', 'GEMINI_API_KEY', 'DASHSCOPE_API_KEY']) {
    const reused = await fixture(t, { env: { ...environment(), [name]: token } });
    assert.equal((await reused.request()).status, 503);
    const reservedName = await fixture(t, { env: { [name]: secondToken,
      NOTIFY_SENDERS_JSON: JSON.stringify([{ ...senderRows[0], token_env: name }]) } });
    assert.equal((await reservedName.request()).status, 503);
  }
});

test('chime callbacks ignoring timeouts retain their bounded active slot across rate-window resets', async t => {
  let time = 100000;
  let release;
  let calls = 0;
  const f = await fixture(t, { now: () => time,
    env: { ...environment(), NOTIFY_INGRESS_MAX_PENDING: '1', NOTIFY_INGRESS_BEEP_TIMEOUT_MS: '1000' },
    beep: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const first = await f.request();
  assert.equal(first.body.beep.status, 'unknown');
  time += 60001;
  const second = await f.request({ ...payload, idempotency_key: 'event:2' });
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'SENDER_BUSY');
  assert.equal(calls, 1);
  release({ status: 'published' });
  await new Promise(resolve => setImmediate(resolve));
  const duplicate = await f.request();
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.beep.status, 'unknown');
  assert.equal(calls, 1);
});

test('approval revoked during inbox write prevents subsequent chime without deleting stored content', async t => {
  const inbox = fakeInbox();
  const enqueue = inbox.enqueue;
  let approved = true;
  inbox.enqueue = async (...args) => { const result = await enqueue(...args); approved = false; return result; };
  const f = await fixture(t, { inbox, resolveDevice: () => ({ status: approved ? 'approved' : 'pending' }) });
  const result = await f.request();
  assert.equal(result.status, 201);
  assert.equal(result.body.stored, true);
  assert.equal(result.body.beep.status, 'not_published');
  assert.equal(f.calls.length, 0);
  assert.equal([...inbox.entries.values()][0].text, payload.text);
  assert.equal([...inbox.entries.values()][0].beep.reason, 'destination_revoked');
});

test('real SQLite inbox survives reopen, persists pending text and prevents a second chime', async t => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { NotificationInbox } = require('../lib/inbox');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaozhi-ingress-test-'));
  const databasePath = path.join(root, 'notifications.sqlite');
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const firstStore = new NotificationInbox({ databasePath });
  stores.push(firstStore);
  const firstApp = await fixture(t, { inbox: firstStore, beep: async () => ({ status: 'not_published' }) });
  const first = await firstApp.request();
  assert.equal(first.body.stored, true);
  assert.equal(first.body.beep.status, 'not_published');
  await firstStore.close();
  const reopened = new NotificationInbox({ databasePath });
  stores.push(reopened);
  const secondApp = await fixture(t, { inbox: reopened });
  const duplicate = await secondApp.request();
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.notification_id, first.body.notification_id);
  assert.equal(duplicate.body.beep.status, 'not_published');
  assert.equal(secondApp.calls.length, 0);
  const record = await reopened.get(deviceId, first.body.notification_id);
  assert.equal(record.text, payload.text);
  assert.equal(record.readAt, null);
});
