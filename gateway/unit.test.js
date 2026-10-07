'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const dgram = require('node:dgram');
const {once} = require('node:events');
const {WebSocketServer} = require('ws');
const {createGateway, header, configFromEnv} = require('./server');
const {generateMqttConfig, validateMqttCredentials, generatePasswordSignature} = require('./credentials');
const {packet, string, Reader, parseConnect} = require('./mqtt');

const deviceId = 'aa:bb:cc:dd:ee:ff';
const signatureKey = crypto.randomBytes(32).toString('hex');
const serviceKey = crypto.randomBytes(32).toString('hex');
const config = generateMqttConfig({groupId: 'GID_local', deviceId, uuid: 'unit-device', signatureKey, endpoint: 'localhost', port: 1883});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function connectPacket(credentials = config, keepAlive = 30) {
  return packet(0x10, Buffer.concat([string('MQTT'), Buffer.from([4, 0xc2, keepAlive >> 8, keepAlive & 255]),
    string(credentials.client_id), string(credentials.username), string(credentials.password)]));
}
class Device {
  constructor(socket) {
    this.socket = socket; socket.setNoDelay(true); this.buffer = Buffer.alloc(0); this.frames = [];
    socket.on('data', (data) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      while (this.buffer.length >= 2) {
        let value = 0; let multiplier = 1; let i = 1;
        for (; i < this.buffer.length; i++) { const digit = this.buffer[i]; value += (digit & 127) * multiplier; if (!(digit & 128)) break; multiplier *= 128; }
        if (this.buffer.length < i + 1 + value) return;
        this.frames.push({type: this.buffer[0] >> 4, body: this.buffer.subarray(i + 1, i + 1 + value)});
        this.buffer = this.buffer.subarray(i + 1 + value);
      }
    });
  }
  async frame(type, timeout = 2000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const index = this.frames.findIndex((f) => f.type === type); if (index >= 0) return this.frames.splice(index, 1)[0]; await pause(5); }
    throw new Error(`Timed out waiting for MQTT type ${type}`);
  }
  async message(type) {
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      const found = this.frames.findIndex((f) => { if (f.type !== 3) return false; const r = new Reader(f.body); r.string(); return JSON.parse(r.bytes(r.remaining()).toString()).type === type; });
      if (found >= 0) { const r = new Reader(this.frames.splice(found, 1)[0].body); const topic = r.string(); return {topic, ...JSON.parse(r.bytes(r.remaining()).toString())}; }
      await pause(5);
    }
    throw new Error(`Timed out waiting for message ${type}`);
  }
  publish(value, topic = 'device-server') { this.socket.write(packet(0x30, Buffer.concat([string(topic), Buffer.from(JSON.stringify(value))]))); }
}
async function fixture(t, options = {}) {
  let approved = true; let registeredId = deviceId; const messages = []; const binaries = []; let lastWs;
  const registry = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${serviceKey}`);
    const url = new URL(req.url, 'http://localhost');
    if (!approved || !url.pathname.endsWith(encodeURIComponent(deviceId)) || url.searchParams.get('client_id') !== config.client_id) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({device_id: registeredId, client_id: config.client_id, token: 'ephemeral-device-token'}));
  });
  const upstream = new WebSocketServer({server: registry, path: '/xiaozhi/v1/'});
  upstream.on('connection', (ws, req) => {
    lastWs = ws;
    assert.equal(req.headers.authorization, 'Bearer ephemeral-device-token');
    assert.equal(req.headers['device-id'], registeredId); assert.equal(req.headers['protocol-version'], '1');
    ws.on('message', (data, binary) => {
      if (binary) { binaries.push(Buffer.from(data)); ws.send(data, {binary: true}); return; }
      const json = JSON.parse(data); messages.push(json);
      if (json.type === 'hello') ws.send(JSON.stringify({type: 'hello', session_id: `session-${messages.length}`, transport: 'websocket', audio_params: {format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60}}));
    });
  });
  registry.listen(0, '127.0.0.1'); await once(registry, 'listening');
  const base = `http://127.0.0.1:${registry.address().port}`;
  const gateway = createGateway({signatureKey, serviceKey, allowInsecure: true, allowHttpAudio: true, registryUrl: `${base}/internal/mqtt/devices/`, upstreamUrl: base.replace('http:', 'ws:') + '/xiaozhi/v1/',
    mqttHost: '127.0.0.1', mqttPort: 0, udpHost: '127.0.0.1', udpPort: 0, httpHost: '127.0.0.1', httpPort: 0,
    publicHost: '127.0.0.1', audioAllowedOrigins: [base], ...options});
  await gateway.start();
  t.after(async () => { await gateway.close(); for (const ws of upstream.clients) ws.terminate(); await new Promise((resolve) => upstream.close(resolve)); await new Promise((resolve) => { registry.close(resolve); registry.closeAllConnections(); }); });
  async function device(credentials = config, fragmented = false, keepAlive = 30) {
    const socket = net.connect(gateway.address().mqtt.port, '127.0.0.1'); await once(socket, 'connect');
    const client = new Device(socket); t.after(() => socket.destroy());
    const bytes = connectPacket(credentials, keepAlive);
    if (fragmented) { for (let i = 0; i < bytes.length; i += 3) socket.write(bytes.subarray(i, i + 3)); }
    else socket.write(bytes);
    return client;
  }
  async function forward(params = {type: 'notify', audio_url: `${base}/notice.mp3`, subtitles: [{start_ms: 0, text: 'Hello'}]}, key = serviceKey) {
    const response = await fetch(`http://127.0.0.1:${gateway.address().http.port}/forward`, {method: 'POST', headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json'}, body: JSON.stringify({method: 'forward', clientId: config.client_id, params})});
    return {status: response.status, ...(await response.json())};
  }
  return {gateway, base, device, forward, messages, binaries, setApproved: (v) => { approved = v; }, setRegisteredId: (v) => { registeredId = v; }, ws: () => lastWs};
}
const hello = {type: 'hello', version: 3, transport: 'udp', features: {mcp: true, aec: true}, audio_params: {format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60}};

test('HMAC credentials match official format and require configured secrets', () => {
  assert.equal(config.endpoint, 'localhost:1883');
  assert.equal(config.password, crypto.createHmac('sha256', signatureKey).update(`${config.client_id}|${config.username}`).digest('base64'));
  assert.equal(validateMqttCredentials(config.client_id, config.username, config.password, signatureKey).deviceId, deviceId);
  assert.throws(() => validateMqttCredentials(config.client_id, config.username, 'wrong', signatureKey));
  assert.throws(() => generatePasswordSignature('x', ''));
  assert.throws(() => generatePasswordSignature('x', 'replace-me-with-a-long-example-key'));
  assert.throws(() => createGateway({signatureKey, serviceKey: signatureKey, allowInsecure: true}), /different/);
  assert.throws(() => createGateway({signatureKey, serviceKey}), /TLS/);
  assert.throws(() => generateMqttConfig({deviceId, uuid: 'unit-device', signatureKey, endpoint: 'localhost:bad'}));
  assert.throws(() => parseConnect(Buffer.from([0, 4, 77])));
  assert.throws(() => configFromEnv({MQTT_TLS_CERT_FILE: '/nonexistent'}));
});

test('fragmented CONNECT, coalesced PING, SUBSCRIBE owner isolation, idle notify, and reconnect', async (t) => {
  const f = await fixture(t); const device = await f.device(config, true);
  assert.deepEqual((await device.frame(2)).body, Buffer.from([0, 0]));
  device.socket.write(Buffer.concat([packet(0xc0), packet(0xc0)]));
  await device.frame(13); await device.frame(13);
  device.socket.write(packet(0x82, Buffer.concat([Buffer.from([0, 3]), string('devices/p2p/aa_bb_cc_dd_ee_ff'), Buffer.from([1]), string('devices/#'), Buffer.from([0])])));
  assert.deepEqual((await device.frame(9)).body, Buffer.from([0, 3, 0, 128]));
  assert.equal((await f.forward()).success, true);
  assert.deepEqual((await device.message('notify')).subtitles, [{start_ms: 0, text: 'Hello'}]);
  const oldClosed = once(device.socket, 'close');
  const fresh = await f.device(); assert.equal((await fresh.frame(2)).body[1], 0); await oldClosed;
  assert.equal(f.gateway.connections.size, 1); assert.equal((await f.forward()).success, true);
  await fresh.message('notify');
});

test('invalid HMAC and unmapped devices fail before successful CONNACK', async (t) => {
  const f = await fixture(t);
  const bad = await f.device({...config, password: 'incorrect'});
  assert.equal((await bad.frame(2)).body[1], 5);
  f.setApproved(false); const denied = await f.device(); assert.equal((await denied.frame(2)).body[1], 5);
  assert.equal(f.gateway.connections.size, 0);
});

test('forward API rejects missing service key, arbitrary methods, foreign origins and revoked destinations', async (t) => {
  const f = await fixture(t); const device = await f.device(); await device.frame(2);
  assert.equal((await f.forward(undefined, 'wrong')).status, 401);
  assert.equal((await f.forward({type: 'system', command: 'reboot'})).success, false);
  assert.equal((await f.forward({type: 'notify', audio_url: 'https://not-allowed.invalid/audio.mp3'})).success, false);
  assert.equal((await f.forward({type: 'notify', audio_url: `${f.base}/x`, command: 'reboot'})).success, false);
  f.setApproved(false); assert.equal((await f.forward()).success, false);
});

test('real AES-CTR UDP/raw Opus bridge, replay filtering, controls and goodbye preserve idle MQTT', async (t) => {
  const f = await fixture(t); const device = await f.device(); await device.frame(2); device.publish(hello);
  const reply = await device.message('hello');
  assert.equal(reply.transport, 'udp'); assert.equal(reply.audio_params.sample_rate, 24000);
  assert.equal(reply.udp.key.length, 32); assert.equal(reply.udp.nonce.length, 32);
  assert.equal(f.messages[0].version, 1); assert.equal(f.messages[0].features.aec, undefined);
  const udp = dgram.createSocket('udp4'); t.after(() => udp.close()); udp.bind(0, '127.0.0.1'); await once(udp, 'listening');
  const opus = Buffer.from([0xf8, 0xff, 0xfe]); const key = Buffer.from(reply.udp.key, 'hex');
  const h = Buffer.from(reply.udp.nonce, 'hex'); h.writeUInt16BE(opus.length, 2); h.writeUInt32BE(42, 8); h.writeUInt32BE(1, 12);
  const cipher = crypto.createCipheriv('aes-128-ctr', key, h); const wire = Buffer.concat([h, cipher.update(opus), cipher.final()]);
  const received = once(udp, 'message'); udp.send(wire, reply.udp.port, reply.udp.server);
  const [response] = await received;
  assert.equal(response[1], 1); assert.equal(wire[1], 0); assert.equal(response.readUInt32BE(12), 1); assert.equal(response.length, 19);
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, response.subarray(0, 16));
  assert.deepEqual(Buffer.concat([decipher.update(response.subarray(16)), decipher.final()]), opus);
  udp.send(wire, reply.udp.port, reply.udp.server); await pause(30); assert.equal(f.binaries.length, 1);
  device.publish({type: 'listen', state: 'start', session_id: reply.session_id});
  device.publish({type: 'mcp', payload: {jsonrpc: '2.0', id: 1, result: {tools: []}}});
  device.publish({type: 'notify', audio_url: `${f.base}/ignored.mp3`});
  await pause(30); assert.equal(f.messages.filter((v) => v.type === 'listen').length, 1);
  assert.equal(f.messages.filter((v) => v.type === 'mcp').length, 1); assert.equal(f.messages.filter((v) => v.type === 'notify').length, 0);
  device.publish({type: 'goodbye', session_id: reply.session_id}); await pause(30);
  assert.equal(f.gateway.sessions.size, 0); assert.equal(f.gateway.connections.size, 1);
  assert.equal((await f.forward()).success, true); await device.message('notify');
  device.publish(hello); const reopened = await device.message('hello'); assert.notEqual(reopened.udp.key, reply.udp.key);
  f.ws().close(); await device.message('goodbye'); assert.equal(f.gateway.connections.size, 1);
});

test('malformed remaining length, oversized frame, wrong topic and stalled handshake close cleanly', async (t) => {
  const f = await fixture(t, {connectTimeout: 200, fragmentTimeout: 200});
  for (const bytes of [Buffer.from([0x10, 255, 255, 255, 255]), Buffer.from([0x10, 255, 255, 1])]) {
    const socket = net.connect(f.gateway.address().mqtt.port, '127.0.0.1'); await once(socket, 'connect');
    const closed = once(socket, 'close'); socket.write(bytes); await closed;
  }
  const device = await f.device(); await device.frame(2); const closed = once(device.socket, 'close'); device.publish({type: 'hello'}, 'another/device'); await closed;
  const stalled = net.connect(f.gateway.address().mqtt.port, '127.0.0.1'); await once(stalled, 'connect'); const done = once(stalled, 'close'); stalled.write(Buffer.from([0x10])); await done;
  assert.equal(f.gateway.connections.size, 0);
});

test('keepalive expiry and audio idle timeout are separate lifetimes', async (t) => {
  const f = await fixture(t, {maxSessionIdle: 150});
  const device = await f.device(config, false, 1); await device.frame(2); device.publish(hello); await device.message('hello');
  await device.message('goodbye'); assert.equal(f.gateway.connections.size, 1);
  assert.equal((await f.forward()).success, true); await device.message('notify');
  const closed = once(device.socket, 'close'); await closed; assert.equal(f.gateway.connections.size, 0);
});


test('coalesced CONNECT and PING serialize authorization; registry MAC spelling is preserved upstream', async (t) => {
  const f = await fixture(t); f.setRegisteredId(deviceId.toUpperCase());
  const socket = net.connect(f.gateway.address().mqtt.port, '127.0.0.1'); await once(socket, 'connect');
  const device = new Device(socket); t.after(() => socket.destroy());
  socket.write(Buffer.concat([connectPacket(), packet(0xc0)]));
  assert.equal((await device.frame(2)).body[1], 0); await device.frame(13);
  device.publish(hello); await device.message('hello');
});

test('QoS-1 retransmission is acknowledged but not duplicated upstream', async (t) => {
  const f = await fixture(t); const device = await f.device(); await device.frame(2); device.publish(hello);
  const reply = await device.message('hello');
  const body = Buffer.concat([string('device-server'), Buffer.from([0, 7]), Buffer.from(JSON.stringify({type: 'abort', session_id: reply.session_id}))]);
  device.socket.write(Buffer.concat([packet(0x32, body), packet(0x3a, body)]));
  assert.deepEqual((await device.frame(4)).body, Buffer.from([0, 7])); await device.frame(4);
  await pause(20); assert.equal(f.messages.filter((v) => v.type === 'abort').length, 1);
});

test('audio origin configuration fails closed and online query is service-key protected', async (t) => {
  const config = {signatureKey, serviceKey, allowInsecure: true, registryUrl: 'http://127.0.0.1/devices/', upstreamUrl: 'ws://127.0.0.1/voice'};
  assert.throws(() => createGateway({...config, audioAllowedOrigins: ['http://localhost']}));
  assert.throws(() => createGateway({...config, audioAllowedOrigins: ['https://localhost/path']}));
  const f = await fixture(t); const device = await f.device(); await device.frame(2);
  const url = `http://127.0.0.1:${f.gateway.address().http.port}/online?clientId=${encodeURIComponent('GID_local@@@aa_bb_cc_dd_ee_ff@@@unit-device')}`;
  assert.equal((await fetch(url)).status, 401);
  const response = await fetch(url, {headers: {Authorization: `Bearer ${serviceKey}`}});
  assert.deepEqual(await response.json(), {online: true});
});


test('startup/close are idempotent and configured endpoint supplies advertised UDP host', async (t) => {
  const values = configFromEnv({MQTT_SIGNATURE_KEY: signatureKey, MQTT_GATEWAY_KEY: serviceKey, MQTT_ENDPOINT: 'voice.local:8883'});
  assert.equal(values.publicHost, 'voice.local'); assert.equal(values.mqttPort, 8883); assert.equal(values.udpPort, 8884);
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.gateway.start(), f.gateway.start()]); assert.deepEqual(a, b);
  await Promise.all([f.gateway.close(), f.gateway.close()]);
  assert.deepEqual(f.gateway.address(), {mqtt: null, udp: null, http: null});
  await assert.rejects(f.gateway.start(), /closed/);
});
