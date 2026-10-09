'use strict';

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const fs = require('node:fs');
const {EventEmitter} = require('node:events');
const WebSocket = require('ws');
const {MqttStream, Reader, parseConnect, packet} = require('./mqtt');
const {validateMqttCredentials, parseClientId, normalizeDeviceId, equalSecret, secret} = require('./credentials');
const {validateNotifyPayload} = require('../lib/notifications');
const {UdpJitterBuffer} = require('../lib/udp-jitter-buffer');

const CONTROL_TYPES = new Set(['listen', 'abort', 'mcp', 'iot']);
const SERVER_TYPES = new Set(['tts', 'stt', 'llm', 'mcp', 'iot', 'system', 'error', 'listen', 'abort']);
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function endpoint(value, protocols, name) {
  let url; try { url = new URL(value); } catch { throw new Error(`Invalid ${name}`); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) throw new Error(`Invalid ${name}`);
  return url;
}
function ip(value) { return value?.replace(/^::ffff:/, ''); }
function audioStats(session) { return { ...session.jitter.snapshot(), ...session.ingress }; }
async function readBounded(stream, limit) {
  const chunks = []; let size = 0;
  for await (const data of stream) { size += data.length; if (size > limit) throw new Error('Payload too large'); chunks.push(Buffer.from(data)); }
  return Buffer.concat(chunks).toString('utf8');
}
function header(route, length = 0, timestamp = 0, sequence = 0) {
  const h = Buffer.alloc(16); h[0] = 1; h.writeUInt16BE(length, 2); h.writeUInt32BE(route, 4);
  h.writeUInt32BE(timestamp >>> 0, 8); h.writeUInt32BE(sequence >>> 0, 12); return h;
}
function audioParams(value) {
  return object(value) && value.format === 'opus' && value.channels === 1 &&
    [8000, 12000, 16000, 24000, 48000].includes(value.sample_rate) && [10, 20, 40, 60].includes(value.frame_duration);
}

class Gateway extends EventEmitter {
  constructor(options) {
    super();
    this.options = {
      mqttHost: '127.0.0.1', mqttPort: 8883, udpHost: '0.0.0.0', udpPort: 8884,
      udpSourcePolicy: 'roaming',
      httpHost: '127.0.0.1', httpPort: 3001, publicHost: '127.0.0.1',
      registryTimeout: 5000, handshakeTimeout: 7000, connectTimeout: 10000,
      fragmentTimeout: 10000, maxPacket: 16384, maxConnections: 256,
      maxWrite: 131072, maxAudioPacket: 4096, maxAudioQueue: 48,
      maxSessionIdle: 120000, maxSessionDuration: 3600000, maxNoKeepAliveIdle: 3600000,
      maxHttpRequests: 64, audioAllowedOrigins: [], allowHttpAudio: false, allowInsecure: false, ...options
    };
    const o = this.options;
    if (!['strict', 'pinned', 'roaming'].includes(o.udpSourcePolicy)) throw new Error('MQTT_UDP_SOURCE_POLICY must be strict, pinned or roaming');
    secret(o.signatureKey, 'MQTT_SIGNATURE_KEY'); secret(o.serviceKey, 'MQTT_GATEWAY_KEY');
    if (!o.tls && o.allowInsecure !== true) throw new Error('MQTT requires TLS; use MQTT_ALLOW_INSECURE=true only on a trusted local network');
    if (equalSecret(o.signatureKey, o.serviceKey)) throw new Error('Use different MQTT signature and gateway keys');
    this.registryUrl = endpoint(o.registryUrl, ['http:', 'https:'], 'registry URL');
    if (this.registryUrl.search) throw new Error('Registry URL cannot contain a query');
    if (!this.registryUrl.pathname.endsWith('/')) this.registryUrl.pathname += '/';
    this.upstreamUrl = endpoint(o.upstreamUrl, ['ws:', 'wss:'], 'upstream URL');
    if (!Array.isArray(o.audioAllowedOrigins)) throw new Error('Audio allowlist must be an array of exact origins');
    if (o.audioAllowedOrigins.length) validateNotifyPayload({type: 'notify', audio_url: new URL(o.audioAllowedOrigins[0]).origin + '/'},
      {allowedAudioOrigins: o.audioAllowedOrigins, allowHttp: o.allowHttpAudio});
    for (const name of ['mqttPort', 'udpPort', 'httpPort']) if (!Number.isInteger(o[name]) || o[name] < 0 || o[name] > 65535) throw new Error(`Invalid ${name}`);
    if (typeof o.publicHost !== 'string' || !o.publicHost || /[\s/:?#]/.test(o.publicHost)) throw new Error('publicHost must be an IPv4 address or hostname');
    this.connections = new Map(); this.peers = new Set(); this.sessions = new Map();
    this.httpActive = 0; this.started = false; this.stopping = false;
    this.udpIngress = { datagrams: 0, malformed: 0, unknown_route: 0 };
    this.lastUdpIngress = { ...this.udpIngress }; this.lastUdpIngressAt = Date.now();
  }
  async registry(deviceId, clientId) {
    const url = new URL(encodeURIComponent(deviceId), this.registryUrl); url.searchParams.set('client_id', clientId);
    const response = await fetch(url, {headers: {Authorization: `Bearer ${this.options.serviceKey}`},
      redirect: 'error', signal: AbortSignal.timeout(this.options.registryTimeout)});
    if (!response.ok) { await response.body?.cancel(); throw new Error('Device is not approved'); }
    const record = JSON.parse(await readBounded(response.body, 8192));
    if (!object(record) || normalizeDeviceId(record.device_id) !== deviceId || record.client_id !== clientId ||
      typeof record.token !== 'string' || !record.token || record.token.length > 4096 || /[\r\n]/.test(record.token)) throw new Error('Invalid device registry response');
    return record;
  }
  address() {
    const read = (server) => { try { return server?.address() || null; } catch { return null; } };
    return {mqtt: read(this.mqttServer), udp: read(this.udpServer), http: read(this.httpServer)};
  }
  async start() {
    if (this.started) return this.address();
    if (this.stopping) throw new Error('Gateway is closed');
    if (!this.startPromise) this.startPromise = this.startListeners();
    return this.startPromise;
  }
  async startListeners() {
    const accept = (socket) => {
      if (this.peers.size >= this.options.maxConnections || this.stopping) return socket.destroy();
      const peer = new Peer(this, socket); this.peers.add(peer);
    };
    this.mqttServer = this.options.tls ? tls.createServer({minVersion: 'TLSv1.2', handshakeTimeout: 10000, ...this.options.tls}, accept) : net.createServer(accept);
    this.mqttServer.maxConnections = this.options.maxConnections;
    this.udpServer = dgram.createSocket('udp4');
    this.httpServer = http.createServer((req, res) => { void this.handleHttp(req, res); });
    this.httpServer.maxConnections = this.options.maxHttpRequests * 2;
    this.httpServer.requestTimeout = 10000; this.httpServer.headersTimeout = 10000; this.httpServer.keepAliveTimeout = 1000;
    this.udpServer.on('message', (message, info) => this.receiveUdp(message, info));
    for (const server of [this.mqttServer, this.udpServer, this.httpServer]) server.on('error', () => this.emit('serverError', new Error('Gateway listener failed')));
    try {
      const listen = (server, start, ready = 'listening') => new Promise((resolve, reject) => {
        const error = (e) => { server.off(ready, ok); reject(e); };
        const ok = () => { server.off('error', error); resolve(); };
        server.once('error', error); server.once(ready, ok); start();
      });
      await listen(this.udpServer, () => this.udpServer.bind(this.options.udpPort, this.options.udpHost));
      if (this.stopping) throw new Error('Gateway closed during startup');
      await listen(this.mqttServer, () => this.mqttServer.listen(this.options.mqttPort, this.options.mqttHost));
      if (this.stopping) throw new Error('Gateway closed during startup');
      await listen(this.httpServer, () => this.httpServer.listen(this.options.httpPort, this.options.httpHost));
      if (this.stopping) throw new Error('Gateway closed during startup');
      this.started = true;
      this.timer = setInterval(() => { for (const peer of this.peers) peer.tick(); this.reportUdpIngress(); }, 500); this.timer.unref();
      return this.address();
    } catch (error) { await this.close(); throw error; }
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.stopping = true; clearInterval(this.timer);
    this.closePromise = (async () => {
      for (const peer of this.peers) peer.close();
      this.connections.clear(); this.sessions.clear();
      await Promise.all([this.mqttServer, this.udpServer, this.httpServer].filter(Boolean).map((server) => new Promise((resolve) => {
        try { server.close(() => resolve()); server.closeAllConnections?.(); } catch { resolve(); }
      })));
      this.started = false;
    })();
    return this.closePromise;
  }
  async handleHttp(req, res) {
    const respond = (status, body) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}); res.end(JSON.stringify(body)); } };
    if (++this.httpActive > this.options.maxHttpRequests) { --this.httpActive; respond(503, {success: false}); req.resume(); return; }
    const abort = setTimeout(() => req.destroy(), 10000); abort.unref();
    try {
      const url = new URL(req.url, 'http://gateway.local');
      if (req.method === 'GET' && url.pathname === '/health') { const ok = this.started && !this.stopping; respond(ok ? 200 : 503, {ok}); return; }
      if (!equalSecret(req.headers.authorization, `Bearer ${this.options.serviceKey}`)) { respond(401, {success: false}); req.resume(); return; }
      if (req.method === 'GET' && url.pathname === '/online') {
        const clientId = url.searchParams.get('clientId');
        const identity = parseClientId(clientId);
        await this.registry(identity.deviceId, clientId);
        const peer = this.connections.get(clientId);
        respond(200, {online: Boolean(peer && peer.connected && !peer.stream.closed)}); return;
      }
      if (req.method !== 'POST' || url.pathname !== '/forward') { respond(404, {success: false}); req.resume(); return; }
      if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { respond(415, {success: false}); req.resume(); return; }
      const body = JSON.parse(await readBounded(req, this.options.maxPacket));
      const keys = object(body) ? Object.keys(body) : [];
      if (!object(body) || keys.some((k) => !['method', 'clientId', 'params'].includes(k)) || body.method !== 'forward') { respond(400, {success: false}); return; }
      const identity = parseClientId(body.clientId);
      if (!this.validNotify(body.params)) { respond(400, {success: false}); return; }
      body.params = validateNotifyPayload(body.params, {allowedAudioOrigins: this.options.audioAllowedOrigins, allowHttp: this.options.allowHttpAudio});
      await this.registry(identity.deviceId, body.clientId);
      const peer = this.connections.get(body.clientId);
      if (!peer || !peer.connected || peer.stream.closed) { respond(200, {success: false}); return; }
      // A successful QoS-0 socket write is not a firmware playback acknowledgement.
      const success = await peer.send(body.params); respond(success ? 200 : 503, {success});
    } catch { respond(400, {success: false}); }
    finally { clearTimeout(abort); --this.httpActive; }
  }
  validNotify(params) {
    if (!object(params) || params.type !== 'notify') return false;
    try { validateNotifyPayload(params, {allowedAudioOrigins: this.options.audioAllowedOrigins, allowHttp: this.options.allowHttpAudio}); return true; }
    catch { return false; }
  }
  allocateRoute() { let route; do { route = crypto.randomBytes(4).readUInt32BE(); } while (!route || this.sessions.has(route)); return route; }
  reportUdpIngress() {
    if (Date.now() - this.lastUdpIngressAt < 5000) return;
    const delta = Object.fromEntries(Object.entries(this.udpIngress).map(([key, value]) => [key, value - this.lastUdpIngress[key]]));
    if (delta.malformed || delta.unknown_route) this.emit('audioStats', {
      event: 'audio.udp_unmatched', level: 'warn', scope: 'gateway', ...this.udpIngress, delta
    });
    this.lastUdpIngress = { ...this.udpIngress }; this.lastUdpIngressAt = Date.now();
  }
  receiveUdp(message, info) {
    this.udpIngress.datagrams++;
    if (message.length < 16) { this.udpIngress.malformed++; return; }
    const session = this.sessions.get(message.readUInt32BE(4));
    if (session) session.ingress.ingress_datagrams++;
    if (message.length < 17 || message.length > 16 + this.options.maxAudioPacket || message[0] !== 1 || message[1] !== 0 || message.readUInt16BE(2) !== message.length - 16) {
      this.udpIngress.malformed++; if (session) session.ingress.rejected_header++; return;
    }
    if (!session) { this.udpIngress.unknown_route++; return; }
    if (!session.ready || session.peer.stream.closed || session.peer.session !== session) { session.ingress.rejected_state++; return; }
    if (this.options.udpSourcePolicy === 'strict' && ip(info.address) !== ip(session.peer.socket.remoteAddress)) {
      session.ingress.rejected_source_ip++; session.lastRejectedSource = { address: info.address, port: info.port }; return;
    }
    const sequence = message.readUInt32BE(12);
    const peerChanged = session.remote && (session.remote.address !== info.address || session.remote.port !== info.port);
    if (peerChanged && this.options.udpSourcePolicy !== 'roaming') {
      session.ingress.rejected_endpoint++; session.lastRejectedSource = { address: info.address, port: info.port }; return;
    }
    if (Date.now() - session.udpRateWindow >= 1000) { session.udpRateWindow = Date.now(); session.udpRateCount = 0; }
    if (++session.udpRateCount > 200) { session.ingress.rejected_rate++; return; }
    if (session.inputStopped) { session.jitter.stats.after_stop++; return; }
    if (!sequence) { session.ingress.rejected_sequence++; return; }
    const cipher = crypto.createDecipheriv('aes-128-ctr', session.key, message.subarray(0, 16));
    const opus = Buffer.concat([cipher.update(message.subarray(16)), cipher.final()]);
    if (!session.jitter.push(sequence, opus) || session.peer.session !== session) return;
    // Reordered audio from a previous mapping can fill a pending hole, but only
    // a newer sequence may select the endpoint for subsequent downlink audio.
    const movePeer = !session.remote || peerChanged && sequence > session.endpointSequence;
    session.endpointSequence = Math.max(session.endpointSequence, sequence);
    if (movePeer) {
      // Legacy UDP has no authentication tag. Route/sequence checks and AES-CTR
      // decryption are not proof of sender identity. Roaming is a compatibility
      // tradeoff for networks whose public UDP address changes during a session.
      session.remote = {address: info.address, port: info.port};
      if (peerChanged) session.ingress.peer_changes++;
      if (!peerChanged || Date.now() - session.lastPeerLogAt >= 5000) {
        session.lastPeerLogAt = Date.now();
        this.emit('audioStats', { event: peerChanged ? 'audio.udp_peer_changed' : 'audio.udp_peer_bound',
          device_id: session.peer.identity.deviceId, session_id: session.sessionId,
          udp_source_policy: this.options.udpSourcePolicy, peer_changes: session.ingress.peer_changes,
          mqtt_peer: ip(session.peer.socket.remoteAddress), udp_peer: session.remote });
      }
    }
    session.lastActivity = Date.now();
    const queued = session.audioQueue.splice(0);
    for (const queuedPacket of queued) session.peer.sendAudio(session, queuedPacket);
  }
}

class Peer {
  constructor(server, socket) {
    this.server = server; this.socket = socket; this.connected = false; this.createdAt = Date.now();
    this.stream = new MqttStream(socket, (first, body) => this.handle(first, body), server.options);
    this.stream.once('close', () => {
      this.connected = false; this.endSession(false);
      if (server.connections.get(this.clientId) === this) server.connections.delete(this.clientId);
      server.peers.delete(this);
    });
    this.recentPublishes = new Map(); this.rateWindow = Date.now(); this.rateCount = 0;
  }
  close() {
    this.connected = false; this.endSession(false);
    if (this.server.connections.get(this.clientId) === this) this.server.connections.delete(this.clientId);
    this.stream.close();
  }
  async handle(first, body) {
    const type = first >> 4; const flags = first & 15;
    if (!this.connected) {
      if (type !== 1 || flags !== 0) throw new Error('CONNECT required');
      try {
        const credentials = parseConnect(body);
        this.identity = validateMqttCredentials(credentials.clientId, credentials.username, credentials.password, this.server.options.signatureKey);
        await this.server.registry(this.identity.deviceId, credentials.clientId);
        if (this.stream.closed) return;
        this.clientId = credentials.clientId; this.keepAlive = credentials.keepAlive;
        this.replyTo = `devices/p2p/${this.identity.deviceId.replace(/:/g, '_')}`;
        const previous = this.server.connections.get(this.clientId); if (previous && previous !== this) previous.close();
        this.connected = true; this.server.connections.set(this.clientId, this);
        await this.stream.write(Buffer.from([0x20, 2, 0, 0]));
      } catch { await this.stream.write(Buffer.from([0x20, 2, 0, 5])); this.close(); }
      return;
    }
    if (Date.now() - this.rateWindow >= 1000) { this.rateWindow = Date.now(); this.rateCount = 0; }
    if (++this.rateCount > 120) throw new Error('Control rate exceeded');
    if (type === 12 && flags === 0 && body.length === 0) { await this.stream.write(Buffer.from([0xd0, 0])); return; }
    if (type === 14 && flags === 0 && body.length === 0) { this.close(); return; }
    if (type === 8 && flags === 2) {
      const reader = new Reader(body); const id = reader.uint16(); if (!id) throw new Error('Invalid packet ID');
      const grants = []; while (reader.remaining()) {
        const topic = reader.string(); const qos = reader.byte(); if (qos > 2 || grants.length >= 16) throw new Error('Invalid subscription');
        grants.push([this.replyTo, 'null'].includes(topic) ? 0 : 128);
      }
      if (!grants.length) throw new Error('Empty subscription');
      const answer = Buffer.from([id >> 8, id & 255, ...grants]); await this.stream.write(packet(0x90, answer)); return;
    }
    if (type === 10 && flags === 2) {
      const reader = new Reader(body); const id = reader.uint16(); let count = 0;
      while (reader.remaining()) { reader.string(); if (++count > 16) throw new Error('Too many topics'); }
      if (!id || !count) throw new Error('Invalid unsubscribe');
      await this.stream.write(packet(0xb0, Buffer.from([id >> 8, id & 255]))); return;
    }
    if (type !== 3 || (flags & 1)) throw new Error('Unsupported MQTT packet');
    const qos = (flags >> 1) & 3;
    if (qos > 1 || (qos === 0 && (flags & 8))) throw new Error('Unsupported QoS');
    const reader = new Reader(body); if (reader.string() !== 'device-server') throw new Error('Topic not permitted');
    const id = qos ? reader.uint16() : null; if (qos && !id) throw new Error('Invalid packet ID');
    const payload = reader.bytes(reader.remaining());
    if (qos) {
      await this.stream.write(packet(0x40, Buffer.from([id >> 8, id & 255])));
      const digest = crypto.createHash('sha256').update(payload).digest('hex');
      const previous = this.recentPublishes.get(id);
      if ((flags & 8) && previous?.digest === digest && Date.now() - previous.time < 60000) return;
      this.recentPublishes.delete(id); this.recentPublishes.set(id, {digest, time: Date.now()});
      if (this.recentPublishes.size > 64) this.recentPublishes.delete(this.recentPublishes.keys().next().value);
    }
    const json = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(payload));
    if (!object(json) || typeof json.type !== 'string') throw new Error('Invalid control message');
    if (json.type === 'hello') { await this.openSession(json); return; }
    if (json.type === 'goodbye') {
      if (this.session && (!json.session_id || json.session_id === this.session.sessionId)) this.endSession(false);
      return;
    }
    // Device-originated notifications and arbitrary actions never enter the forwarding path.
    if (!CONTROL_TYPES.has(json.type)) return;
    if (!this.session?.ready) return;
    if (json.session_id && json.session_id !== this.session.sessionId) return;
    if (json.type === 'mcp' && !object(json.payload)) return;
    if (json.type === 'listen' && json.state === 'stop') {
      const session = this.session;
      session.inputWatch = null;
      if (session.inputStopped) return;
      session.jitter.requestEnd(() => {
        if (this.session !== session) return;
        session.inputStopped = true;
        this.sendUpstream(JSON.stringify(json), false);
      });
      session.lastActivity = Date.now(); return;
    }
    if (json.type === 'listen' && json.state === 'start') {
      this.session.jitter.cancelEnd();
      this.session.inputStopped = false;
      this.session.inputWatch ||= { since: Date.now(), warned: false };
    }
    this.session.lastActivity = Date.now(); this.sendUpstream(JSON.stringify(json), false);
  }
  send(json) { if (!this.connected) return Promise.resolve(false); return this.stream.publish(this.replyTo, json); }
  async openSession(hello) {
    if (hello.version !== 3 || hello.transport !== 'udp' || !audioParams(hello.audio_params) || hello.audio_params.sample_rate !== 16000) {
      await this.send({type: 'error', message: 'Expected protocol 3, UDP, mono 16000 Hz Opus'}); return;
    }
    this.endSession(false);
    const session = {peer: this, route: this.server.allocateRoute(), key: crypto.randomBytes(16), remote: null,
      localSequence: 0, remoteSequence: 0, endpointSequence: 0, timestamp: 0, ready: false, controlReady: false, audioQueue: [], controlQueue: [],
      createdAt: Date.now(), lastActivity: Date.now(), udpRateWindow: Date.now(), udpRateCount: 0, pendingUdp: 0};
    this.session = session; this.server.sessions.set(session.route, session);
    session.ingress = { ingress_datagrams: 0, rejected_header: 0, rejected_state: 0,
      rejected_source_ip: 0, rejected_endpoint: 0, rejected_rate: 0, rejected_sequence: 0, peer_changes: 0 };
    session.inputDuration = hello.audio_params.frame_duration;
    session.lastStatsAt = Date.now();
    session.jitter = new UdpJitterBuffer({
      onPacket: (opus, sequence) => {
        if (this.session === session && this.sendUpstream(opus, true)) {
          session.remoteSequence = sequence;
          if (session.inputWatch) {
            if (session.inputWatch.warned) this.server.emit('audioStats', {
              event: 'audio.udp_input_resumed', device_id: this.identity.deviceId, session_id: session.sessionId,
              gap_ms: Date.now() - session.inputWatch.since, ...audioStats(session)
            });
            // Watch only the first audio after listen.start. Later silence can
            // be intentional (DTX or firmware speaking mode), not a broken path.
            session.inputWatch = null;
          }
        }
      },
      onGap: frames => {
        if (this.session === session) this.sendUpstream(JSON.stringify({ type: 'audio_gap', frames,
          frame_duration: session.inputDuration }), false);
      }
    });
    try {
      const record = await this.server.registry(this.identity.deviceId, this.clientId);
      if (this.session !== session || this.stream.closed) return;
      const remainingHelloMs = Math.min(this.server.options.handshakeTimeout, Math.max(1, 9000 - (Date.now() - session.createdAt)));
      const ws = new WebSocket(this.server.upstreamUrl, {headers: {
        'Device-Id': record.device_id, 'Client-Id': this.identity.uuid, 'Protocol-Version': '1', Authorization: `Bearer ${record.token}`
      }, handshakeTimeout: remainingHelloMs, maxPayload: this.server.options.maxPacket, perMessageDeflate: false, followRedirects: false});
      session.ws = ws;
      const reply = await new Promise((resolve, reject) => {
        let greeted = false;
        session.helloTimer = setTimeout(() => reject(new Error('Upstream hello timed out')), remainingHelloMs); session.helloTimer.unref();
        ws.on('open', () => {
          if (this.session !== session) return ws.terminate();
          const features = object(hello.features) ? {...hello.features} : {};
          // This backend carries raw Opus and does not preserve AEC timestamps.
          delete features.aec;
          ws.send(JSON.stringify({...hello, version: 1, transport: 'websocket', features}));
        });
        ws.on('message', (data, binary) => {
          if (this.session !== session) return;
          try {
            if (binary) { if (greeted) this.sendAudio(session, Buffer.from(data)); return; }
            const message = JSON.parse(data.toString()); if (!object(message)) throw new Error('Invalid upstream message');
            if (message.type === 'hello' && !greeted) {
              if (typeof message.session_id !== 'string' || !message.session_id || message.session_id.length > 256 || !audioParams(message.audio_params)) throw new Error('Invalid upstream hello');
              greeted = true; session.sessionId = message.session_id; session.frameDuration = message.audio_params.frame_duration;
              clearTimeout(session.helloTimer); resolve(message); return;
            }
            if (message.type === 'goodbye') { this.endSession(true); return; }
            if (!SERVER_TYPES.has(message.type)) return;
            if (!session.controlReady) { if (session.controlQueue.length >= 32) throw new Error('Control queue exceeded'); session.controlQueue.push(message); }
            else void this.send(message).then((ok) => { if (!ok) this.close(); });
          } catch { reject(new Error('Invalid upstream message')); this.endSession(true); }
        });
        ws.on('error', () => { reject(new Error('Upstream connection failed')); this.endSession(true, session); });
        ws.on('close', () => { reject(new Error('Upstream closed')); this.endSession(true, session); });
      });
      if (this.session !== session || this.stream.closed) return;
      const helloWritten = await this.send({type: 'hello', version: 3, session_id: session.sessionId, transport: 'udp',
        udp: {server: this.server.options.publicHost, port: this.server.address().udp.port, encryption: 'aes-128-ctr',
          key: session.key.toString('hex'), nonce: header(session.route).toString('hex')}, audio_params: reply.audio_params});
      if (!helloWritten) return this.close();
      session.ready = true;
      while (session.controlQueue.length && this.session === session) {
        if (!await this.send(session.controlQueue.shift())) return this.close();
      }
      session.controlReady = true;
    } catch {
      if (this.session === session) this.endSession(false);
      if (this.connected && !this.session) await this.send({type: 'error', message: 'Audio session unavailable'});
    }
  }
  sendUpstream(data, binary) {
    const session = this.session;
    if (!session?.ready || session.ws?.readyState !== WebSocket.OPEN) return false;
    if (session.ws.bufferedAmount + Buffer.byteLength(data) > this.server.options.maxWrite) { this.endSession(true); return false; }
    session.ws.send(data, {binary}, (error) => { if (error) this.endSession(true, session); }); return true;
  }
  sendAudio(session, opus) {
    if (this.session !== session || !opus.length || opus.length > this.server.options.maxAudioPacket) return;
    session.lastActivity = Date.now();
    if (!session.ready || !session.remote) {
      if (session.audioQueue.length >= this.server.options.maxAudioQueue) { this.endSession(true); return; }
      session.audioQueue.push(opus); return;
    }
    if (session.localSequence >= 0xffffffff) { this.endSession(true); return; }
    if (session.pendingUdp >= 64) { this.endSession(true); return; }
    const h = header(session.route, opus.length, session.timestamp, ++session.localSequence);
    // Stock firmware ignores flags but uses the entire header as IV. Separate
    // directions prevent equal uplink/downlink headers from reusing an IV.
    h[1] = 1;
    session.timestamp = (session.timestamp + session.frameDuration) >>> 0;
    const cipher = crypto.createCipheriv('aes-128-ctr', session.key, h);
    const data = Buffer.concat([h, cipher.update(opus), cipher.final()]);
    session.pendingUdp++;
    this.server.udpServer.send(data, session.remote.port, session.remote.address, (error) => { session.pendingUdp--; if (error) this.endSession(true, session); });
  }
  endSession(notify, expected = this.session) {
    const session = this.session;
    if (!session || expected !== session) return;
    this.server.emit('audioStats', { device_id: this.identity.deviceId, session_id: session.sessionId,
      event: 'audio.udp_session_closed', ...audioStats(session) });
    session.jitter.stop();
    this.session = null; this.server.sessions.delete(session.route); clearTimeout(session.helloTimer);
    session.ready = false; session.audioQueue.length = 0; session.controlQueue.length = 0; session.key.fill(0);
    if (notify && session.sessionId && this.connected) void this.send({type: 'goodbye', session_id: session.sessionId});
    if (session.ws && session.ws.readyState !== WebSocket.CLOSED) session.ws.terminate();
  }
  tick() {
    const now = Date.now(); const o = this.server.options;
    if ((!this.connected && now - this.createdAt > o.connectTimeout) ||
      (this.stream.partialSince && now - this.stream.partialSince > o.fragmentTimeout) ||
      (this.connected && now - this.stream.lastPacketAt > (this.keepAlive ? this.keepAlive * 1500 : o.maxNoKeepAliveIdle))) { this.close(); return; }
    const session = this.session;
    if (session?.ready && session.inputWatch && !session.inputWatch.warned && now - session.inputWatch.since >= 5000) {
      session.inputWatch.warned = true;
      this.server.emit('audioStats', { event: 'audio.udp_input_stalled', level: 'warn',
        device_id: this.identity.deviceId, session_id: session.sessionId,
        no_audio_ms: now - session.inputWatch.since, ...audioStats(session),
        advertised_host: o.publicHost, advertised_port: this.server.address().udp?.port,
        udp_source_policy: o.udpSourcePolicy,
        mqtt_peer: ip(this.socket.remoteAddress), udp_peer: session.remote,
        last_rejected_source: session.lastRejectedSource || null
      });
    }
    if (session?.ready && now - session.lastStatsAt >= 5000) {
      session.lastStatsAt = now;
      this.sendUpstream(JSON.stringify({ type: 'audio_transport_stats', stats: audioStats(session) }), false);
    }
    if (session && (now - session.lastActivity > o.maxSessionIdle || now - session.createdAt > o.maxSessionDuration ||
      (session.audioQueue.length && !session.remote && now - session.createdAt > 10000))) this.endSession(true);
  }
}

function configFromEnv(env = process.env) {
  const port = (name, fallback) => env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  const config = {signatureKey: env.MQTT_SIGNATURE_KEY, serviceKey: env.MQTT_GATEWAY_KEY,
    registryUrl: env.MQTT_REGISTRY_URL || 'http://127.0.0.1:3000/internal/mqtt/devices/',
    upstreamUrl: env.MQTT_UPSTREAM_URL || 'ws://127.0.0.1:3000/xiaozhi/v1/',
    mqttHost: env.MQTT_BIND_HOST || '127.0.0.1', mqttPort: port('MQTT_PORT', 8883),
    udpHost: env.MQTT_UDP_BIND_HOST || env.UDP_HOST || '0.0.0.0', udpPort: port('MQTT_UDP_PORT', port('UDP_PORT', 8884)),
    udpSourcePolicy: env.MQTT_UDP_SOURCE_POLICY || 'roaming',
    publicHost: env.MQTT_PUBLIC_HOST || env.PUBLIC_IP || (env.MQTT_ENDPOINT ? env.MQTT_ENDPOINT.split(':')[0] : '127.0.0.1'),
    httpHost: env.MQTT_HTTP_BIND_HOST || env.HTTP_HOST || '127.0.0.1', httpPort: port('MQTT_HTTP_PORT', port('HTTP_PORT', 3001)),
    allowInsecure: env.MQTT_ALLOW_INSECURE === 'true', allowHttpAudio: env.NOTIFY_ALLOW_HTTP === 'true',
    audioAllowedOrigins: (env.MQTT_AUDIO_ALLOWED_ORIGINS || env.NOTIFY_ALLOWED_AUDIO_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)};
  const certPath = env.MQTT_TLS_CERT_FILE || env.MQTT_TLS_CERT;
  const keyPath = env.MQTT_TLS_KEY_FILE || env.MQTT_TLS_KEY;
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('Both MQTT TLS certificate and key paths are required');
  if (certPath) config.tls = {cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath)};
  return config;
}
function createGateway(options) { return new Gateway(options); }
module.exports = {createGateway, configFromEnv, header};

if (require.main === module) {
  require('dotenv').config({quiet: true});
  let gateway;
  try { gateway = createGateway(configFromEnv()); }
  catch (error) { console.error(`Gateway configuration error: ${error.message}`); process.exitCode = 1; }
  if (gateway) {
    gateway.on('serverError', () => { console.error('Gateway listener failed'); void gateway.close().finally(() => { process.exitCode = 1; }); });
    gateway.on('audioStats', stats => console[stats.level === 'warn' ? 'warn' : 'info'](`Gateway audio stats: ${JSON.stringify(stats)}`));
    gateway.start().then((addresses) => console.log(`MQTT gateway listening on ${addresses.mqtt.address}:${addresses.mqtt.port}; UDP ${addresses.udp.port}; UDP source policy ${gateway.options.udpSourcePolicy}; private HTTP ${addresses.http.address}:${addresses.http.port}`))
      .catch(() => { console.error('Gateway startup failed'); process.exitCode = 1; });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void gateway.close(); });
  }
}
