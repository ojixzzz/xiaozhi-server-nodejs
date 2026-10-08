'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID, randomBytes } = require('node:crypto');
const { McpEndpoint } = require('../lib/mcp-endpoint');

const tool = { name: 'calculator', description: 'Calculate', inputSchema: { type: 'object', properties: { a: { type: 'number' } } } };
const tick = () => new Promise(resolve => setImmediate(resolve));
class PipeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; }
  send(text, callback) {
    const message = JSON.parse(text);
    this.sent.push(message);
    queueMicrotask(() => { this.handle?.(message); callback?.(); });
  }
  receive(message) { this.emit('message', Buffer.from(JSON.stringify(message)), false); }
  ping() { this.emit('pong'); }
  close() { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } }
  terminate() { this.close(); }
}

function fixture(t) {
  const sender = { name: `agent-${randomUUID()}`, token: randomBytes(32).toString('hex'),
    config: { deviceId: 'alpha', baseUrl: 'https://relay.example.com', name: 'My agent' } };
  let active = true, approved = true;
  const selections = [], changes = [], notifications = [];
  const endpoint = new McpEndpoint({ connections: { senders: () => active ? [sender] : [], active: row => active && row === sender },
    isDeviceAllowed: id => approved && id === 'alpha',
    onReady: (...args) => { selections.push(args); }, onChanged: (...args) => { changes.push(args); },
    publish: async (row, args) => { notifications.push({ row, args }); return { stored: true, notification_id: 'message-1' }; },
    publicError: () => ({ stored: false, error: 'Notification rejected' }) });
  t.after(() => endpoint.close());
  async function connect(tools = [tool], override) {
    const ws = new PipeSocket();
    ws.handle = message => {
      if (message.method === 'initialize') ws.receive({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stdio-example', version: '1' }
      } });
      if (message.method === 'tools/list') ws.receive({ jsonrpc: '2.0', id: message.id, result: { tools } });
      if (message.method === 'tools/call') {
        if (override) override(ws, message);
        else ws.receive({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '42' }] } });
      }
    };
    await endpoint.accept(ws, sender);
    return ws;
  }
  return { endpoint, sender, connect, selections, changes, notifications,
    revoke: () => { active = false; endpoint.revoke(sender.name); }, disapprove: () => { approved = false; } };
}
const caller = { deviceId: 'alpha', sessionId: 'voice-1' };

test('auth requires a live paired token and approved device, and rejects foreign origins', t => {
  const f = fixture(t);
  const request = { url: `/mcp_endpoint/mcp/?token=${f.sender.token}`, headers: {} };
  assert.equal(f.endpoint.authenticate(request), f.sender);
  assert.equal(f.endpoint.authenticate({ ...request, headers: { origin: 'https://foreign.example' } }), null);
  assert.equal(f.endpoint.authenticate({ ...request, headers: { authorization: `Bearer ${'a'.repeat(64)}` } }), null);
  assert.equal(f.endpoint.authenticate({ ...request, headers: { authorization: 'Basic invalid' } }), null);
  assert.equal(f.endpoint.authenticate({ ...request, url: request.url + '&token=' + f.sender.token }), null);
  assert.equal(f.endpoint.authenticate({ url: '/mcp_endpoint/mcp/', headers: { authorization: `Bearer ${f.sender.token}` } }), f.sender);
  f.disapprove();
  assert.equal(f.endpoint.authenticate(request), null);
});

test('raw calculator pipe framing negotiates MCP, discovers tools and dispatches caller metadata', async t => {
  const f = fixture(t);
  const ws = await f.connect();
  assert.deepEqual(ws.sent.slice(0, 3).map(message => message.method), ['initialize', 'notifications/initialized', 'tools/list']);
  assert.deepEqual(f.selections, [['alpha', f.sender.name]]);
  assert.equal(f.endpoint.status(f.sender.name).connected, true);
  assert.equal(f.endpoint.tools(f.sender.name)[0].name, 'calculator');
  assert.equal(f.endpoint.routes(new Set(), 'alpha').size, 0);
  assert.equal(f.endpoint.routes(new Set([f.sender.name]), 'beta').size, 0);
  const route = [...f.endpoint.routes(new Set([f.sender.name]), 'alpha').values()][0];
  await assert.rejects(f.endpoint.call(route, {}, { ...caller, deviceId: 'beta' }), /no longer available/);
  const result = await f.endpoint.call(route, { a: 1 }, caller);
  assert.equal(result.untrusted, true);
  assert.equal(result.result.content[0].text, '42');
  const call = ws.sent.find(message => message.method === 'tools/call');
  assert.equal(call.params.name, 'calculator');
  assert.deepEqual(call.params._meta, { 'xiaozhi/device_id': 'alpha', 'xiaozhi/session_id': 'voice-1' });
});

test('multiple stdio providers have distinct aliases and cannot answer another socket request', async t => {
  const f = fixture(t);
  let outgoing;
  const a = await f.connect([tool], (ws, message) => { outgoing = message; });
  const b = await f.connect();
  const routes = [...f.endpoint.routes(new Set([f.sender.name]), 'alpha').values()];
  assert.equal(routes.length, 2);
  assert.notEqual(routes[0].definition.name, routes[1].definition.name);
  assert.equal(f.endpoint.status(f.sender.name).provider_count, 2);
  let settled = false;
  const pending = f.endpoint.call(routes[0], {}, caller).then(result => { settled = true; return result; });
  await tick();
  b.receive({ jsonrpc: '2.0', id: outgoing.id, result: { content: [{ type: 'text', text: 'wrong provider' }] } });
  await tick();
  assert.equal(settled, false);
  a.receive({ jsonrpc: '2.0', id: outgoing.id, result: { content: [{ type: 'text', text: 'correct provider' }] } });
  assert.equal((await pending).result.content[0].text, 'correct provider');
});

test('agent inbox requests use paired identity and receipts for both extension methods', async t => {
  const f = fixture(t);
  const ws = await f.connect();
  const args = { title: 'Selesai', text: 'Hasil tugas', idempotency_key: 'job-1' };
  ws.receive({ jsonrpc: '2.0', id: 'notify-1', method: 'xiaozhi/notify', params: args });
  ws.receive({ jsonrpc: '2.0', id: 'notify-2', method: 'tools/call', params: { name: 'notify_send', arguments: args } });
  await tick();
  assert.equal(f.notifications.length, 2);
  assert.ok(f.notifications.every(value => value.row === f.sender));
  assert.deepEqual(f.notifications[0].args, args);
  assert.equal(ws.sent.find(message => message.id === 'notify-1').result.structuredContent.stored, true);
  assert.equal(ws.sent.find(message => message.id === 'notify-2').result.isError, false);
  ws.receive({ jsonrpc: '2.0', method: 'xiaozhi/notify', params: args });
  await tick();
  assert.equal(f.notifications.length, 2);
  assert.equal(ws.sent.find(message => message.id === null).error.code, -32600);
});

test('disconnect and revocation invalidate captured tools and close voice sessions', async t => {
  const f = fixture(t);
  const ws = await f.connect();
  const route = [...f.endpoint.routes(new Set([f.sender.name]), 'alpha').values()][0];
  ws.close();
  await assert.rejects(f.endpoint.call(route, {}, caller), /no longer available/);
  assert.deepEqual(f.changes, [['alpha', f.sender.name]]);
  const reconnected = await f.connect();
  f.revoke();
  assert.equal(reconnected.readyState, 3);
  assert.equal(f.endpoint.status(f.sender.name).connected, false);
  assert.deepEqual(f.endpoint.tools(f.sender.name), []);
});

test('invalid discovery never enables partially discovered tools', async t => {
  const f = fixture(t);
  await f.connect([tool, tool]);
  assert.equal(f.endpoint.status(f.sender.name).connected, false);
  assert.equal(f.endpoint.tools(f.sender.name).length, 0);
  assert.equal(f.selections.length, 0);
  assert.ok(f.endpoint.status(f.sender.name).error);
});

test('four concurrent calls are allowed, disconnected outcome is unknown and never retried', async t => {
  const f = fixture(t);
  const ws = await f.connect([tool], () => {});
  const route = [...f.endpoint.routes(new Set([f.sender.name]), 'alpha').values()][0];
  const pending = Array.from({ length: 4 }, () => f.endpoint.call(route, {}, caller).catch(error => error));
  await assert.rejects(f.endpoint.call(route, {}, caller), /busy/);
  ws.close();
  const errors = await Promise.all(pending);
  assert.ok(errors.every(error => /outcome is unknown/.test(error.message)));
  assert.equal(ws.sent.filter(message => message.method === 'tools/call').length, 4);
});
