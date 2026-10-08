'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AgentConnections } = require('../lib/agent-connections');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaozhi-pairing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const servers = new Map();
  const selections = [];
  const remoteMcp = {
    list: () => [...servers.values()],
    async save(input) {
      const id = input.id || `remote-${randomUUID()}`;
      const server = { id, connected: true, tools: [{ name: 'agent_reply' }], ...input };
      servers.set(id, server);
      return server;
    },
    async remove(id) { servers.delete(id); }
  };
  const options = { filename: path.join(directory, 'agent-connections.json'), remoteMcp,
    resolveDevice: id => ['alpha', 'beta'].includes(id) ? { status: 'approved' } : null,
    onRegistered: (device, server) => { selections.push({ device, server }); } };
  return { manager: new AgentConnections(options), options, servers, selections };
}
const setup = device_id => ({ name: 'My agent', device_id, public_url: 'https://relay.example.com/' });

test('setup exports a scoped token, lists no secrets and survives restart', async t => {
  const f = fixture(t);
  const created = await f.manager.create(setup('alpha'));
  const sender = f.manager.senders()[0];
  assert.equal(sender.devices.size, 1);
  assert.equal(sender.devices.has('alpha'), true);
  assert.equal(created.mcp_config.mcpServers.xiaozhi.url, 'https://relay.example.com/mcp/notifications');
  assert.equal(created.mcp_config.mcpServers.xiaozhi.headers.Authorization, `Bearer ${sender.token}`);
  assert.equal(created.mcp_endpoint, `wss://relay.example.com/mcp_endpoint/mcp/?token=${sender.token}`);
  assert.deepEqual(created.environment, { MCP_ENDPOINT: created.mcp_endpoint });
  assert.equal(sender.defaultDeviceId, 'alpha');
  assert.equal(JSON.stringify(f.manager.list()).includes(sender.token), false);
  assert.equal(fs.statSync(f.options.filename).mode & 0o777, 0o600);
  const restarted = new AgentConnections(f.options);
  assert.deepEqual(restarted.export(created.connection.id), f.manager.export(created.connection.id));
  assert.equal(restarted.senders()[0].devices.has('beta'), false);
});

test('registration selects only the paired device and updates only its own server', async t => {
  const f = fixture(t);
  await f.manager.create(setup('alpha'));
  await f.manager.create(setup('beta'));
  const [alpha, beta] = f.manager.senders();
  const result = await f.manager.register(alpha, { url: 'https://agent.example.com/mcp', token: 'separate-agent-token' });
  assert.equal(result.connected, true);
  assert.deepEqual(f.selections, [{ device: 'alpha', server: alpha.config.serverId }]);
  assert.equal(beta.config.serverId, null);
  assert.equal(JSON.stringify(result).includes('separate-agent-token'), false);
  const firstId = alpha.config.serverId;
  await f.manager.register(alpha, { url: 'https://agent.example.com/new-mcp' });
  assert.equal(alpha.config.serverId, firstId);
  assert.equal(f.servers.size, 1);
  await assert.rejects(f.manager.register(alpha, { url: 'https://agent.example.com/mcp', device_id: 'beta' }), /only url/);
  await assert.rejects(f.manager.register(alpha, { url: 'https://agent.example.com/mcp', token: alpha.token }), /separate/);
});

test('removing a pairing revokes the sender and its remote tools', async t => {
  const f = fixture(t);
  const revoked = [];
  f.manager.onRevoked = id => revoked.push(id);
  const created = await f.manager.create(setup('alpha'));
  const sender = f.manager.senders()[0];
  await f.manager.register(sender, { url: 'https://agent.example.com/mcp' });
  await f.manager.remove(created.connection.id);
  assert.deepEqual(revoked, [created.connection.id]);
  assert.equal(f.servers.size, 0);
  assert.equal(f.manager.active(sender), false);
  assert.deepEqual(f.manager.senders(), []);
  assert.deepEqual(f.manager.tools(sender), []);
  await assert.rejects(f.manager.register(sender, { url: 'https://agent.example.com/mcp' }), /no longer approved/);
  assert.throws(() => f.manager.export(created.connection.id), /not found/);
  assert.deepEqual(new AgentConnections(f.options).list(), []);
});

test('revocation during an asynchronous approval lookup cannot create a remote server', async t => {
  const f = fixture(t);
  const created = await f.manager.create(setup('alpha'));
  const sender = f.manager.senders()[0];
  let release;
  f.manager.resolveDevice = () => new Promise(resolve => { release = resolve; });
  const registration = f.manager.register(sender, { url: 'https://agent.example.com/mcp' });
  await f.manager.remove(created.connection.id);
  release({ status: 'approved' });
  await assert.rejects(registration, /no longer approved/);
  assert.equal(f.servers.size, 0);
});

test('invalid or corrupt settings fail closed without overwriting the file', async t => {
  const f = fixture(t);
  await assert.rejects(f.manager.create(setup('missing')), /approved/);
  await assert.rejects(f.manager.create({ ...setup('alpha'), public_url: 'https://user:password@relay.example.com' }), /public dashboard/);
  await f.manager.create(setup('alpha'));
  const rows = JSON.parse(fs.readFileSync(f.options.filename));
  rows.push({ ...rows[0], id: `agent-${randomUUID()}` });
  const contents = JSON.stringify(rows);
  fs.writeFileSync(f.options.filename, contents);
  assert.throws(() => new AgentConnections(f.options), /Invalid agent configuration/);
  assert.equal(fs.readFileSync(f.options.filename, 'utf8'), contents);
});
