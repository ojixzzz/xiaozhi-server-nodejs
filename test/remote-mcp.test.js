'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { RemoteMcpServers, toolAlias, boundedResult, restrictedFetch } = require('../lib/remote-mcp');

const tool = { name: 'agent_submit_task', description: 'Submit a task', inputSchema: { type: 'object', properties: { instruction: { type: 'string' } }, required: ['instruction'] } };
const settings = { name: 'My agent', url: 'https://agent.example.com/mcp', transport: 'streamable-http', token: 'ephemeral-test-token-only' };
async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaozhi-remote-mcp-'));
  const filename = path.join(directory, 'remote-mcp-servers.json');
  const clients = [];
  const calls = [];
  const createClient = (config, signal) => {
    const client = {
      async connect() {},
      async listTools() { return { tools: [tool] }; },
      async callTool(params, _, options) { calls.push({ config, params, options }); return { content: [{ type: 'text', text: 'accepted' }], structuredContent: { accepted: true, job_id: 'job-1' } }; },
      async close() { this.closed = true; this.onclose?.(); }
    };
    clients.push({ client, signal });
    return { client, transport: {} };
  };
  const manager = new RemoteMcpServers({ filename, createClient, ...overrides });
  t.after(async () => { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { manager, filename, clients, calls, createClient };
}

test('settings persist privately, survive restart, and never return Bearer credentials', async t => {
  const f = await fixture(t);
  const saved = await f.manager.save(settings);
  assert.equal(saved.connected, true);
  assert.equal(saved.tokenConfigured, true);
  assert.equal(JSON.stringify(f.manager.list()).includes(settings.token), false);
  assert.equal((await fs.stat(f.filename)).mode & 0o777, 0o600);
  await f.manager.close();
  const restarted = new RemoteMcpServers({ filename: f.filename, createClient: f.createClient });
  t.after(() => restarted.close());
  await restarted.ensure([saved.id]);
  assert.equal(restarted.list()[0].connected, true);
  assert.equal(f.clients.length, 2);
  assert.equal(JSON.stringify(restarted.list()).includes(settings.token), false);
});

test('editing preserves a blank token, clears null, and disabling disconnects', async t => {
  const f = await fixture(t);
  const saved = await f.manager.save(settings);
  await f.manager.save({ ...settings, id: saved.id, token: '' });
  assert.equal(f.manager.list()[0].tokenConfigured, true);
  assert.equal(JSON.parse(await fs.readFile(f.filename, 'utf8'))[0].token, settings.token);
  await f.manager.save({ ...settings, id: saved.id, token: null, enabled: false });
  assert.equal(f.manager.list()[0].tokenConfigured, false);
  assert.equal(f.manager.list()[0].connected, false);
  assert.equal(f.manager.list()[0].status, 'disabled');
  assert.equal(f.manager.routes([saved.id]).size, 0);
  assert.ok(f.clients.every(({ client }) => client.closed));
});

test('routes require device selection, isolate identical names and send authenticated caller metadata', async t => {
  const f = await fixture(t);
  const a = await f.manager.save(settings);
  const b = await f.manager.save({ ...settings, name: 'Other agent', url: 'https://other.example.com/mcp' });
  assert.equal(f.manager.routes([]).size, 0);
  const routes = f.manager.routes([a.id, b.id]);
  assert.equal(routes.size, 2);
  assert.notEqual(toolAlias(a.id, tool.name), toolAlias(b.id, tool.name));
  assert.ok([...routes.keys()].every(name => name.length <= 64));
  const result = await f.manager.call(routes.get(toolAlias(a.id, tool.name)), { instruction: 'Summarize report' }, { deviceId: 'owned-device', sessionId: 'voice-session' });
  assert.equal(result.result.structuredContent.accepted, true);
  assert.equal(result.untrusted, true);
  assert.equal(f.calls[0].params.name, tool.name);
  assert.deepEqual(f.calls[0].params._meta, { 'xiaozhi/device_id': 'owned-device', 'xiaozhi/session_id': 'voice-session' });
  assert.equal(f.calls[0].options.timeout, 30000);
});

test('saved connection changes and deletion invalidate old routes before dispatch', async t => {
  const f = await fixture(t);
  const saved = await f.manager.save(settings);
  const old = [...f.manager.routes([saved.id]).values()][0];
  await f.manager.save({ ...settings, id: saved.id, url: 'https://replacement.example.com/mcp' });
  await assert.rejects(f.manager.call(old, {}), /no longer available/);
  assert.equal(f.calls.length, 0);
  const updated = [...f.manager.routes([saved.id]).values()][0];
  await f.manager.remove(saved.id);
  await assert.rejects(f.manager.call(updated, {}), /no longer available/);
  assert.equal(f.manager.list().length, 0);
  assert.deepEqual(JSON.parse(await fs.readFile(f.filename, 'utf8')), []);
});

test('URLs and credentials are validated before persistence or network access', async t => {
  const f = await fixture(t);
  for (const url of ['file:///tmp/test', 'http://lan-agent/mcp', 'https://user:pass@agent.example/mcp', 'https://agent.example/mcp?token=secret', 'https://agent.example/mcp#fragment']) {
    await assert.rejects(f.manager.save({ ...settings, url }), { status: 400 });
  }
  await assert.rejects(f.manager.save({ ...settings, token: 'bad\nheader' }), { status: 400 });
  await assert.rejects(f.manager.save({ ...settings, token: false }), { status: 400 });
  assert.equal(f.clients.length, 0);
  await f.manager.save({ ...settings, url: 'http://127.0.0.1:1234/mcp' });
  assert.equal(f.clients.length, 1);
});

test('paginated discovery completes and repeated cursors fail without exposing partial tools', async t => {
  let broken = false;
  const f = await fixture(t, { createClient: () => ({ transport: {}, client: {
    async connect() {}, async close() {},
    async listTools(params) {
      if (!params.cursor) return { tools: [tool], nextCursor: 'page-two' };
      return { tools: [{ ...tool, name: 'agent_task_status' }], ...(broken ? { nextCursor: 'page-two' } : {}) };
    }
  } }) });
  const saved = await f.manager.save(settings);
  assert.equal(saved.tools.length, 2);
  broken = true;
  const refreshed = await f.manager.refresh(saved.id);
  assert.equal(refreshed.connected, false);
  assert.equal(refreshed.tools.length, 0);
  assert.ok(refreshed.error);
});

test('failed tool execution is unknown and is never automatically retried', async t => {
  const f = await fixture(t);
  const saved = await f.manager.save(settings);
  let attempts = 0;
  f.clients[0].client.callTool = async () => { attempts++; throw new Error('timeout and a private remote credential'); };
  const route = [...f.manager.routes([saved.id]).values()][0];
  await assert.rejects(f.manager.call(route, {}, { deviceId: 'device', sessionId: 'session' }), error => {
    assert.match(error.message, /outcome is unknown/);
    assert.equal(error.message.includes('credential'), false);
    return true;
  });
  assert.equal(attempts, 1);
});

test('concurrent calls are bounded and refreshed tool schemas invalidate old session definitions', async t => {
  const f = await fixture(t);
  const saved = await f.manager.save(settings);
  const route = [...f.manager.routes([saved.id]).values()][0];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let dispatched = 0;
  f.clients[0].client.callTool = async () => { dispatched++; await gate; return { content: [{ type: 'text', text: 'done' }] }; };
  const caller = { deviceId: 'device', sessionId: 'session' };
  const pending = Array.from({ length: 4 }, () => f.manager.call(route, {}, caller));
  await assert.rejects(f.manager.call(route, {}, caller), /busy; no action was dispatched/);
  assert.equal(dispatched, 4);
  release();
  await Promise.all(pending);
  const entry = f.manager.entries.get(saved.id);
  entry.tools = [{ ...tool, inputSchema: { type: 'object', properties: { other: { type: 'string' } } } }];
  await assert.rejects(f.manager.call(route, {}, caller), /has changed/);
  assert.equal(dispatched, 4);
});

test('untrusted tool errors and structured content are preserved within the result budget', () => {
  const result = { isError: true, content: [{ type: 'text', text: 'task rejected' }], structuredContent: { accepted: false } };
  assert.deepEqual(boundedResult(result).result, result);
  const large = boundedResult({ ...result, content: [{ type: 'text', text: '"\\'.repeat(10000) }] });
  assert.ok(JSON.stringify(large).length <= 6000);
  assert.equal(large.truncated, true);
  assert.equal(large.isError, true);
});

test('transport fetch never follows redirects or sends credentials outside the configured origin', async () => {
  const calls = [];
  const controller = new AbortController();
  const request = restrictedFetch('https://agent.example.com', controller.signal, async (url, init) => {
    calls.push({ url, init });
    return new Response('ok');
  });
  const response = await request('https://agent.example.com/messages', { headers: { Authorization: 'Bearer private' } });
  assert.equal(await response.text(), 'ok');
  assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(request('https://other.example.com/messages', { headers: { Authorization: 'Bearer private' } }), /origin changed/);
  assert.equal(calls.length, 1);
});

test('official SDK negotiates a custom HTTP MCP server and forwards auth, tools and caller metadata', { timeout: 20000 }, async t => {
  const messages = [];
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${settings.token}`) { res.writeHead(401).end(); return; }
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw);
    messages.push({ request, headers: req.headers });
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'custom-test-agent', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [tool] };
    else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'Task accepted' }], structuredContent: { accepted: true, job_id: 'custom-job' } };
    else { res.writeHead(400).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const f = await fixture(t, { createClient: undefined });
  const saved = await f.manager.save({ ...settings, url: `http://127.0.0.1:${server.address().port}/mcp` });
  assert.equal(saved.connected, true, saved.error);
  const route = [...f.manager.routes([saved.id]).values()][0];
  const result = await f.manager.call(route, { instruction: 'Prepare report' }, { deviceId: 'owned-device', sessionId: 'voice-session' });
  assert.equal(result.result.structuredContent.job_id, 'custom-job');
  const dispatched = messages.find(message => message.request.method === 'tools/call');
  assert.equal(dispatched.request.params._meta['xiaozhi/device_id'], 'owned-device');
  assert.equal(dispatched.request.params.name, tool.name);
  assert.ok(dispatched.headers['mcp-protocol-version']);
  assert.ok(messages.some(message => message.request.method === 'notifications/initialized'));
});
