'use strict';

// Loopback integration of the real MQTT/UDP gateway and the real Node app.
// Only the paid model provider is replaced. This exercises a protocol mock,
// not physical ESP32 hardware, its firmware, TLS deployment, or audible playback.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const OpusScript = require('opusscript');
const WebSocket = require('ws');
const { MqttDevice } = require('./helpers/mqtt-device');
const { createGateway } = require('../gateway/server');

const ROOT = path.join(__dirname, '..');
const MAC = '02:00:00:00:00:01';
const OTHER_MAC = '02:00:00:00:00:02';
const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_UUID = '22222222-2222-4222-8222-222222222222';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await predicate();
    if (result) return result;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}

async function allocatePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function tone(sampleRate, samples, frequency) {
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index++) pcm.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * frequency * index / sampleRate)), index * 2);
  return pcm;
}

function encode(pcm, rate, samples) {
  const codec = new OpusScript(rate, 1);
  try { return Buffer.from(codec.encode(pcm, samples)); } finally { codec.delete(); }
}

function decode(opus, rate) {
  const codec = new OpusScript(rate, 1);
  try { return Buffer.from(codec.decode(opus)); } finally { codec.delete(); }
}

async function fixture(t, gatewayOptions = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xiaozhi-mqtt-integration-'));
  const eventsPath = path.join(directory, 'provider-events.jsonl');
  const hookPath = path.join(directory, 'fake-gemini.cjs');
  const audioDirectory = path.join(directory, 'audio');
  await fs.mkdir(audioDirectory);
  const audioBytes = await fs.readFile(path.join(ROOT, 'notification-audio/sample-chime.ogg'));
  await fs.writeFile(path.join(audioDirectory, 'test-chime.ogg'), audioBytes);
  const outputPcm = tone(24000, 1440, 660);
  await fs.writeFile(hookPath, `
    'use strict';
    const Module = require('node:module');
    const EventEmitter = require('node:events');
    const fs = require('node:fs');
    const originalLoad = Module._load;
    const record = data => fs.appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(data) + '\\n');
    class FakeGemini extends EventEmitter {
      constructor(config) { super(); this.config = config; this.closed = false; }
      async connect() { record({ type: 'connect' }); this.emit('connected'); }
      sendAudio(pcm) {
        record({ type: 'input_audio', pcm: pcm.toString('base64') });
        if (!this.responded && !this.closed) {
          this.responded = true;
          this.emit('audio_output', Buffer.from(${JSON.stringify(outputPcm.toString('base64'))}, 'base64'));
          this.emit('turn_complete');
        }
      }
      interrupt() { record({ type: 'interrupt' }); }
      sendToolResponse() {}
      close() { if (this.closed) return; this.closed = true; record({ type: 'close' }); this.emit('close'); }
    }
    Module._load = function(request, parent, isMain) {
      if (request === './providers/gemini' && parent?.filename.endsWith('/app.js')) return FakeGemini;
      return originalLoad.apply(this, arguments);
    };
  `);
  await fs.writeFile(path.join(directory, 'devices.json'), JSON.stringify({
    [MAC]: { status: 'approved', uuid: UUID, token: 'ephemeral-device-one', prompt: 'Local protocol test', enabled_mcp_devices: [] },
    [OTHER_MAC]: { status: 'approved', uuid: OTHER_UUID, token: 'ephemeral-device-two', prompt: 'Local protocol test', enabled_mcp_devices: [] }
  }));

  const port = await allocatePort();
  const base = `http://127.0.0.1:${port}`;
  const serviceKey = crypto.randomBytes(32).toString('hex');
  const signatureKey = crypto.randomBytes(32).toString('hex');
  const gateway = createGateway({
    signatureKey, serviceKey,
    registryUrl: `${base}/internal/mqtt/devices/`,
    upstreamUrl: `ws://127.0.0.1:${port}/xiaozhi/v1/`,
    mqttHost: '127.0.0.1', mqttPort: 0,
    udpHost: '127.0.0.1', udpPort: 0, publicHost: '127.0.0.1',
    httpHost: '127.0.0.1', httpPort: 0,
    audioAllowedOrigins: [base], allowHttpAudio: true, allowInsecure: true, ...gatewayOptions
  });
  let child;
  let gatewayClosed = false;
  let output = '';
  const mockDevices = [];
  t.after(async () => {
    await Promise.all(mockDevices.map(device => device.close()));
    if (!gatewayClosed) await gateway.close();
    if (child && child.exitCode === null) {
      const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      const result = await exit;
      clearTimeout(timer);
      assert.equal(result.code, 0, output);
    }
    await fs.rm(directory, { recursive: true, force: true });
  });

  const addresses = await gateway.start();
  const gatewayBase = `http://127.0.0.1:${addresses.http.port}`;
  child = spawn(process.execPath, ['--require', hookPath, 'app.js'], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH, HOME: directory, DATA_DIR: directory,
      HOST: '127.0.0.1', PORT: String(port), ADMIN_PASSWORD: 'local-integration-only',
      WEBSOCKET_URL_FOR_ALLOWED_DEVICE: `ws://127.0.0.1:${port}/xiaozhi/v1/`,
      GEMINI_API_KEY: 'fake-provider-preload-never-uses-this', LLM_BACKEND: 'gemini',
      DOTENV_CONFIG_PATH: path.join(directory, 'no-dotenv'),
      DEVICE_TIMEZONE_OFFSET_MINUTES: '330', MQTT_ENABLED: 'true', MQTT_SIGNATURE_KEY: signatureKey, MQTT_GATEWAY_KEY: serviceKey,
      MQTT_ENDPOINT: `127.0.0.1:${addresses.mqtt.port}`, MQTT_PUBLIC_HOST: '127.0.0.1',
      MQTT_ALLOW_INSECURE: 'true', MQTT_GATEWAY_URL: gatewayBase,
      NOTIFY_ENABLED: 'true', NOTIFY_ALLOW_HTTP: 'true', NOTIFY_ALLOWED_AUDIO_ORIGINS: base,
      NOTIFY_AUDIO_BASE_URL: base, NOTIFY_AUDIO_DIR: audioDirectory
    }
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Node app exited ${child.exitCode}: ${output}`);
    try { return (await fetch(`${base}/health`)).ok; } catch { return false; }
  }, 'Node app readiness');
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'local-integration-only' }) });
  assert.equal(login.status, 200, output);
  const headers = { Cookie: login.headers.get('set-cookie').split(';')[0], 'Content-Type': 'application/json', 'X-Requested-With': 'XiaozhiDashboard' };
  const gatewayHeaders = { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

  return {
    base, gatewayBase, gatewayHeaders, headers, addresses, signatureKey, serviceKey, outputPcm, audioBytes,
    async readEvents() {
      try { return (await fs.readFile(eventsPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
    makeDevice(config) { const device = new MqttDevice(config); mockDevices.push(device); return device; },
    async selectTransport(mac, transport) {
      return fetch(`${base}/api/devices/${encodeURIComponent(mac)}/transport`, { method: 'POST', headers, body: JSON.stringify({ transport }) });
    },
    async ota(mac = MAC, uuid = UUID) {
      const response = await fetch(`${base}/xiaozhi/ota/`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Device-Id': mac, 'Client-Id': uuid }, body: JSON.stringify({ mac_address: mac, uuid }) });
      assert.equal(response.status, 200);
      return response.json();
    },
    async online(clientId) {
      const response = await fetch(`${gatewayBase}/online?clientId=${encodeURIComponent(clientId)}`, { headers: gatewayHeaders });
      assert.equal(response.status, 200);
      return (await response.json()).online;
    },
    async notify(mac, body, authHeaders = headers) {
      const response = await fetch(`${base}/api/devices/${encodeURIComponent(mac)}/notifications`, { method: 'POST', headers: authHeaders, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    async stopGateway() { await gateway.close(); gatewayClosed = true; }
  };
}

test('real MQTT/UDP gateway bridges a protocol device to Node and delivers idle notifications', { timeout: 60000 }, async t => {
  const f = await fixture(t);
  let config;
  let otherConfig;
  let device;
  let firstHello;
  let signedAudioUrl;

  await t.test('pending and approved OTA use configured minute offsets and UTC millisecond timestamps', async () => {
    const approved = await f.ota();
    const pending = await f.ota('02:00:00:00:00:99', '99999999-9999-4999-8999-999999999999');
    for (const response of [approved, pending]) {
      assert.equal(response.server_time.timezone_offset, 330);
      assert.ok(Number.isSafeInteger(response.server_time.timestamp));
      assert.ok(Math.abs(response.server_time.timestamp-Date.now())<10000, 'timestamp remains current UTC milliseconds, without pre-applying timezone');
    }
  });

  await t.test('admin selection and OTA issue signed, exact per-device MQTT credentials', async () => {
    const original = await f.ota();
    assert.deepEqual(original.websocket, { url: `${f.base.replace('http:', 'ws:')}/xiaozhi/v1/`, token: 'ephemeral-device-one' }, 'existing devices default to the actual configured WebSocket endpoint and dedicated token');
    assert.equal(original.mqtt, undefined);
    const noCsrf = await fetch(`${f.base}/api/devices/${encodeURIComponent(MAC)}/transport`, { method: 'POST', headers: { Cookie: f.headers.Cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ transport: 'mqtt' }) });
    assert.equal(noCsrf.status, 403);
    assert.equal((await f.selectTransport(MAC, 'mqtt')).status, 200);
    assert.equal((await f.selectTransport(OTHER_MAC, 'mqtt')).status, 200);
    const ota = await f.ota();
    assert.equal(ota.server_time.timezone_offset,330,'MQTT OTA uses the same minute setting');
    config = ota.mqtt;
    otherConfig = (await f.ota(OTHER_MAC, OTHER_UUID)).mqtt;
    assert.ok(config);
    assert.equal(ota.websocket, undefined, 'MQTT-selected OTA is unambiguous');
    assert.equal(config.endpoint, `127.0.0.1:${f.addresses.mqtt.port}`);
    assert.equal(config.publish_topic, 'device-server');
    assert.equal(config.password, crypto.createHmac('sha256', f.signatureKey).update(`${config.client_id}|${config.username}`).digest('base64'));
    assert.notEqual(config.password, otherConfig.password);
    assert.ok(config.client_id.includes(MAC.replaceAll(':', '_')));
    assert.equal(config.password.includes('ephemeral-device-one'), false);

    const registry = `${f.base}/internal/mqtt/devices/${encodeURIComponent(MAC)}?client_id=${encodeURIComponent(config.client_id)}`;
    assert.equal((await fetch(registry)).status, 401);
    const authorized = await fetch(registry, { headers: f.gatewayHeaders });
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { device_id: MAC, client_id: config.client_id, token: 'ephemeral-device-one' });
    assert.equal((await fetch(`${f.base}/internal/mqtt/devices/${encodeURIComponent(MAC)}?client_id=${encodeURIComponent(otherConfig.client_id)}`, { headers: f.gatewayHeaders })).status, 404);
  });

  await t.test('authenticated audio selection issues a signed mono Ogg URL usable without device authorization headers', async () => {
    assert.equal((await fetch(`${f.base}/api/notification-audio`)).status, 401);
    assert.equal((await fetch(`${f.base}/api/notification-audio/url`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test-chime.ogg' }) })).status, 401);
    const listed = await fetch(`${f.base}/api/notification-audio`, { headers: f.headers });
    assert.equal(listed.status, 200);
    const listing = await listed.json();
    assert.equal(listing.configured, true);
    assert.deepEqual(listing.files, [{ name: 'test-chime.ogg', size: f.audioBytes.length }]);
    const noCsrf = await fetch(`${f.base}/api/notification-audio/url`, { method: 'POST', headers: { Cookie: f.headers.Cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'test-chime.ogg' }) });
    assert.equal(noCsrf.status, 403);
    const issued = await fetch(`${f.base}/api/notification-audio/url`, { method: 'POST', headers: f.headers, body: JSON.stringify({ name: 'test-chime.ogg' }) });
    assert.equal(issued.status, 200);
    const link = await issued.json();
    signedAudioUrl = link.audio_url;
    const parsed = new URL(signedAudioUrl);
    assert.equal(parsed.origin, f.base);
    assert.equal(parsed.pathname, '/notification-audio/test-chime.ogg');
    assert.match(parsed.searchParams.get('signature'), /^[a-f0-9]{64}$/);
    assert.equal(signedAudioUrl.includes(f.serviceKey), false);
    assert.equal(signedAudioUrl.includes(f.signatureKey), false);
    assert.ok(Date.parse(link.expires_at) > Date.now());
    assert.ok(Date.parse(link.expires_at) <= Date.now() + 300000);

    // Match firmware's URL-only GET: no dashboard cookie or Authorization header.
    const download = await fetch(signedAudioUrl);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-type'), 'audio/ogg');
    assert.equal(Number(download.headers.get('content-length')), f.audioBytes.length);
    assert.match(download.headers.get('cache-control'), /no-store/);
    const bytes = Buffer.from(await download.arrayBuffer());
    assert.deepEqual(bytes, f.audioBytes);
    assert.equal(bytes.toString('ascii', 0, 4), 'OggS');
    const opusHeader = 27 + bytes[26];
    assert.equal(bytes.toString('ascii', opusHeader, opusHeader + 8), 'OpusHead');
    assert.equal(bytes[opusHeader + 9], 1, 'downloaded Ogg identification header advertises mono Opus');
    const tampered = new URL(signedAudioUrl);
    const signature = tampered.searchParams.get('signature');
    tampered.searchParams.set('signature', (signature[0] === '0' ? '1' : '0') + signature.slice(1));
    assert.equal((await fetch(tampered)).status, 403);
    assert.equal((await fetch(`${f.base}/notification-audio/test-chime.ogg`)).status, 403);
    assert.deepEqual(await f.readEvents(), [], 'audio selection and fetch never start a model session');
  });

  await t.test('invalid password and a correctly signed but unregistered identity are rejected', async () => {
    const invalid = f.makeDevice({ ...config, password: 'wrong-password' });
    assert.notEqual(await invalid.connect({ port: f.addresses.mqtt.port }), 0);
    await invalid.waitClosed();
    const unregistered = { ...config, client_id: config.client_id.replace('02_00_00_00_00_01', '02_00_00_00_00_99') };
    unregistered.password = crypto.createHmac('sha256', f.signatureKey).update(`${unregistered.client_id}|${unregistered.username}`).digest('base64');
    const unknown = f.makeDevice(unregistered);
    assert.notEqual(await unknown.connect({ port: f.addresses.mqtt.port }), 0);
    await unknown.waitClosed();
    assert.equal(await f.online(config.client_id), false);
    assert.deepEqual(await f.readEvents(), []);
  });

  await t.test('idle stock-topic notification arrives through Node authenticated route and built-in HTTP adapter', async () => {
    device = f.makeDevice(config);
    assert.equal(await device.connect({ port: f.addresses.mqtt.port, fragmented: true }), 0);
    assert.equal(await f.online(config.client_id), true);
    assert.equal(await f.online(otherConfig.client_id), false);
    assert.equal((await fetch(`${f.gatewayBase}/online?clientId=${encodeURIComponent(config.client_id)}`)).status, 401);
    assert.deepEqual(await f.readEvents(), [], 'MQTT control connect alone never opens a model session');
    const notification = { audio_url: signedAudioUrl, subtitles: [{ start_ms: 0, text: 'Local notification test' }], idempotency_key: 'idle-once' };
    assert.equal((await f.notify(MAC, notification, { 'Content-Type': 'application/json' })).status, 401);
    const result = await f.notify(MAC, notification);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'published');
    assert.equal(result.body.reason, 'gateway_write_confirmed');
    assert.equal(result.body.playback, 'unknown');
    const message = await device.waitForMessage(message => message.type === 'notify');
    assert.equal(message.topic, `devices/p2p/${MAC.replaceAll(':', '_')}`);
    assert.equal(message.qos, 0);
    assert.equal(message.retained, false);
    assert.deepEqual(message.payload, { type: 'notify', audio_url: notification.audio_url, subtitles: notification.subtitles });
    const duplicate = await f.notify(MAC, notification);
    assert.equal(duplicate.body.id, result.body.id);
    assert.equal(duplicate.body.duplicate, true);
    const expired = await f.notify(MAC, { ...notification, idempotency_key: 'expired', expires_at: Date.now() - 1 });
    assert.equal(expired.status, 410);
    await delay(50);
    assert.equal(device.history.filter(message => message.payload.type === 'notify').length, 1);
    assert.deepEqual(await f.readEvents(), [], 'notification while idle does not open audio/model resources');
    assert.equal(await device.subscribe(`devices/p2p/${MAC.replaceAll(':', '_')}`), 0);
    await device.ping();
  });

  await t.test('stock hello plus encrypted UDP Opus reaches fake provider PCM and returns valid encrypted Opus', async () => {
    firstHello = await device.openAudio();
    assert.equal(firstHello.type, 'hello');
    assert.equal(firstHello.version, 3);
    assert.equal(firstHello.transport, 'udp');
    assert.equal(firstHello.udp.port, f.addresses.udp.port);
    assert.equal(firstHello.udp.encryption, 'aes-128-ctr');
    assert.match(firstHello.udp.key, /^[a-f0-9]{32}$/i);
    assert.match(firstHello.udp.nonce, /^[a-f0-9]{32}$/i);
    assert.equal(Buffer.from(firstHello.udp.nonce, 'hex')[0], 1);
    assert.deepEqual(firstHello.audio_params, { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60 });
    assert.ok(firstHello.session_id);
    await device.waitForMessage(message => message.type === 'listen' && message.state === 'start', 8000);
    assert.ok(device.history.some(message => message.payload.type === 'mcp' && message.payload.payload.method === 'initialize'));
    assert.ok(device.history.some(message => message.payload.type === 'mcp' && message.payload.payload.method === 'tools/list'));

    const uplink = encode(tone(16000, 960, 440), 16000, 960);
    const expectedInputPcm = decode(uplink, 16000);
    assert.equal(expectedInputPcm.length, 1920);
    const uplinkPacket = await device.sendAudio(uplink, 120);
    assert.equal(uplinkPacket[1], 0, 'stock firmware uplink keeps the advertised zero flag');
    const input = await until(async () => (await f.readEvents()).find(event => event.type === 'input_audio'), 'provider received decoded UDP uplink');
    assert.deepEqual(Buffer.from(input.pcm, 'base64'), expectedInputPcm);
    const downlink = await device.receiveAudio();
    assert.equal(downlink.header[0], 1);
    assert.equal(downlink.header[1], 1, 'downlink uses a separate AES-CTR IV direction bit');
    assert.equal(downlink.header.readUInt16BE(2), downlink.opus.length);
    assert.equal(downlink.packet.length, 16 + downlink.opus.length);
    assert.equal(downlink.header.readUInt32BE(4), Buffer.from(firstHello.udp.nonce, 'hex').readUInt32BE(4));
    assert.equal(downlink.header.readUInt32BE(12), 1);
    assert.notDeepEqual(downlink.packet.subarray(16), downlink.opus, 'downlink payload is encrypted');
    const outputPcm = decode(downlink.opus, 24000);
    assert.equal(outputPcm.length, 2880);
    assert.deepEqual(outputPcm, decode(encode(f.outputPcm, 24000, 1440), 24000), 'PCM provider output traverses the real app encoder as raw Opus, without a WS v2 header');
    assert.ok(outputPcm.some(value => value !== 0));
    device.publish({ type: 'abort', session_id: firstHello.session_id, reason: 'wake_word_detected' });
    await until(async () => (await f.readEvents()).some(event => event.type === 'interrupt'), 'MQTT abort reached provider');
    assert.deepEqual(device.errors, []);
  });

  await t.test('goodbye closes only audio and reconnect replaces control connection with fresh audio keys', async () => {
    device.goodbye();
    await until(async () => (await f.readEvents()).some(event => event.type === 'close'), 'goodbye closed Node voice session');
    await device.ping();
    assert.equal(await f.online(config.client_id), true, 'idle MQTT control persists after audio goodbye');
    const previous = device;
    device = f.makeDevice(config);
    assert.equal(await device.connect({ port: f.addresses.mqtt.port }), 0);
    await previous.waitClosed();
    await device.ping();
    assert.equal(await f.online(config.client_id), true);
    const secondHello = await device.openAudio({ features: {} });
    assert.notEqual(secondHello.session_id, firstHello.session_id);
    assert.notEqual(secondHello.udp.key, firstHello.udp.key);
    assert.notEqual(secondHello.udp.nonce, firstHello.udp.nonce);
    await device.waitForMessage(message => message.type === 'listen' && message.state === 'start');
    await device.sendAudio(encode(tone(16000, 960, 550), 16000, 960), 240);
    const downlink = await device.receiveAudio();
    assert.equal(decode(downlink.opus, 24000).length, 2880);
    assert.equal(downlink.header.readUInt32BE(12), 1);
    assert.equal((await f.readEvents()).filter(event => event.type === 'connect').length, 2);
    device.goodbye();
    await until(async () => (await f.readEvents()).filter(event => event.type === 'close').length === 2, 'second voice session closed');
    await device.ping();
  });

  await t.test('offline, revoked mapping, and unavailable gateway retain truthful notification outcomes', async () => {
    const offline = await f.notify(OTHER_MAC, { audio_url: `${f.base}/offline.ogg`, idempotency_key: 'offline-only' });
    assert.equal(offline.status, 200);
    assert.equal(offline.body.status, 'not_published');
    assert.equal(offline.body.playback, 'unknown');
    const laterOnline = f.makeDevice(otherConfig);
    assert.equal(await laterOnline.connect({ port: f.addresses.mqtt.port }), 0);
    await delay(50);
    assert.equal(laterOnline.history.filter(message => message.payload.type === 'notify').length, 0, 'offline notifications are not queued for later delivery');
    await laterOnline.close();
    await device.close();
    await until(async () => !(await f.online(config.client_id)), 'disconnected device became offline');
    await delay(1050); // Application notification rate limit is intentionally enabled.
    const disconnected = await f.notify(MAC, { audio_url: `${f.base}/disconnected.ogg`, idempotency_key: 'disconnected' });
    assert.equal(disconnected.body.status, 'not_published');
    assert.equal(disconnected.body.playback, 'unknown');

    assert.equal((await f.selectTransport(MAC, 'websocket')).status, 200);
    const revoked = f.makeDevice(config);
    assert.notEqual(await revoked.connect({ port: f.addresses.mqtt.port }), 0);
    await revoked.waitClosed();
    const revertedOta = await f.ota();
    assert.equal(revertedOta.mqtt, undefined);
    assert.deepEqual(revertedOta.websocket, { url: `${f.base.replace('http:', 'ws:')}/xiaozhi/v1/`, token: 'ephemeral-device-one' });
    const websocket = new WebSocket(revertedOta.websocket.url, { headers: { 'Device-Id': MAC, Authorization: `Bearer ${revertedOta.websocket.token}` } });
    t.after(() => websocket.terminate());
    await new Promise((resolve, reject) => { websocket.once('open', resolve); websocket.once('error', reject); });
    const websocketHello = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Restored WebSocket OTA endpoint did not answer hello')), 5000);
      websocket.on('message', (data, isBinary) => {
        if (isBinary) return;
        const message = JSON.parse(data.toString());
        if (message.type === 'hello') { clearTimeout(timeout); resolve(message); }
      });
    });
    websocket.send(JSON.stringify({ type: 'hello', transport: 'websocket', audio_params: { format: 'opus', sample_rate: 16000, channels: 1, frame_duration: 60 } }));
    assert.equal((await websocketHello).transport, 'websocket');
    const websocketClosed = new Promise(resolve => websocket.once('close', resolve));
    websocket.close();
    await websocketClosed;
    await f.stopGateway();
    await delay(1050);
    const unavailable = await f.notify(OTHER_MAC, { audio_url: `${f.base}/unavailable.ogg`, idempotency_key: 'unavailable' });
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.body.status, 'unknown');
    assert.equal(unavailable.body.reason, 'gateway_error');
    assert.equal(unavailable.body.playback, 'unknown');
  });
});

test('gateway audio expiry preserves MQTT while MQTT keepalive expiry removes the idle device', { timeout: 20000 }, async t => {
  const f = await fixture(t, { maxSessionIdle: 300 });
  assert.equal((await f.selectTransport(MAC, 'mqtt')).status, 200);
  const config = (await f.ota()).mqtt;
  const device = f.makeDevice(config);
  assert.equal(await device.connect({ port: f.addresses.mqtt.port }), 0);
  const hello = await device.openAudio({ features: {} });
  await device.waitForMessage(message => message.type === 'listen' && message.state === 'start');
  const goodbye = await device.waitForMessage(message => message.type === 'goodbye', 3000);
  assert.equal(goodbye.payload.session_id, hello.session_id);
  await until(async () => (await f.readEvents()).some(event => event.type === 'close'), 'audio idle expiry closed provider');
  await device.ping();
  assert.equal(await f.online(config.client_id), true);
  await device.close();
  await until(async () => !(await f.online(config.client_id)), 'old MQTT control closed');

  const replacement = f.makeDevice(config);
  assert.equal(await replacement.connect({ port: f.addresses.mqtt.port, keepAlive: 1 }), 0);
  await replacement.waitClosed(4000);
  assert.equal(await f.online(config.client_id), false);
  assert.equal((await f.readEvents()).filter(event => event.type === 'connect').length, 1, 'keepalive-only MQTT connection never started provider');
});
