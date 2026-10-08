'use strict';

const { randomUUID } = require('node:crypto');
const { safeEqual } = require('./mqtt-integration');
const { toolAlias, boundedResult } = require('./remote-mcp');

const MAX_PAYLOAD = 256 * 1024;
const MAX_TOOLS = 64;
const TIMEOUT = 10000;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const requestId = value => Number.isSafeInteger(value) || typeof value === 'string' && value.length > 0 && value.length <= 128;

// The calculator pipe forwards one JSON-RPC object per WebSocket frame directly
// to a local stdio MCP server. The relay acts as its MCP client over this transport.
class EndpointTransport {
  constructor(ws, notify) { this.ws = ws; this.notify = notify; this.closed = false; this.started = false; }
  async start() {
    if (this.started || this.ws.readyState !== 1) throw new Error('MCP endpoint is not open');
    this.started = true;
    this.message = (bytes, binary) => {
      try {
        if (binary) throw new Error('Text JSON-RPC required');
        const value = JSON.parse(bytes.toString());
        if (!plainObject(value) || value.jsonrpc !== '2.0') throw new Error('Invalid JSON-RPC');
        if (value.method === 'xiaozhi/notify' || value.method === 'tools/call' && value.params?.name === 'notify_send') {
          // A request must have an ID: never persist a fire-and-forget notification.
          if (!requestId(value.id)) {
            void this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Inbox requests require an ID' } }).catch(() => {});
            return;
          }
          const args = value.method === 'xiaozhi/notify' ? value.params : value.params.arguments;
          void this.notify(value.id, args);
          return;
        }
        this.onmessage?.(value);
      } catch { this.ws.close(1008, 'Invalid MCP JSON-RPC message'); }
    };
    this.finish = () => {
      if (this.closed) return;
      this.closed = true;
      this.ws.off('message', this.message);
      this.ws.off('error', this.error);
      this.ws.off('close', this.finish);
      this.onclose?.();
    };
    this.error = () => this.onerror?.(new Error('MCP endpoint connection error'));
    this.ws.on('message', this.message);
    this.ws.on('error', this.error);
    this.ws.on('close', this.finish);
  }
  async send(value) {
    const text = JSON.stringify(value);
    if (this.closed || this.ws.readyState !== 1 || Buffer.byteLength(text) > MAX_PAYLOAD || this.ws.bufferedAmount > MAX_PAYLOAD) throw new Error('MCP endpoint cannot send');
    await new Promise((resolve, reject) => this.ws.send(text, error => error ? reject(new Error('MCP endpoint write failed')) : resolve()));
  }
  async close() {
    this.finish?.();
    if (this.ws.readyState === 1 || this.ws.readyState === 0) this.ws.close(1000, 'MCP endpoint closed');
  }
}

class McpEndpoint {
  constructor({ connections, isDeviceAllowed, onReady, onChanged, publish, publicError, createClient }) {
    Object.assign(this, { connections, isDeviceAllowed, onReady, onChanged, publish, publicError, createClient });
    this.peers = new Map();
    this.errors = new Map();
    this.closed = false;
  }
  authenticate(req) {
    if (this.closed || req.url.length > 4096) return null;
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return null; }
    if (url.searchParams.getAll('token').length > 1) return null;
    const queryToken = url.searchParams.get('token');
    const headerToken = req.headers.authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
    if (req.headers.authorization !== undefined && !headerToken) return null;
    if (queryToken !== null && headerToken && queryToken !== headerToken) return null;
    const token = headerToken || queryToken;
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
    let sender;
    for (const row of this.connections.senders()) if (safeEqual(token, row.token)) sender = row;
    if (!sender || !this.isDeviceAllowed(sender.config.deviceId)) return null;
    if (req.headers.origin && req.headers.origin !== new URL(sender.config.baseUrl).origin) return null;
    return sender;
  }
  status(id) {
    const peers = [...this.peers.values()].filter(peer => peer.sender.name === id);
    const ready = peers.filter(peer => peer.ready && this.current(peer));
    return { connected: ready.length > 0, connecting: peers.some(peer => !peer.ready && this.current(peer)),
      provider_count: ready.length, tools_count: ready.reduce((sum, peer) => sum + peer.tools.length, 0),
      error: this.errors.get(id) || null };
  }
  tools(id) {
    return [...this.peers.values()].filter(peer => peer.sender.name === id && peer.ready && this.current(peer))
      .flatMap(peer => peer.tools.map(tool => ({ ...tool, exposedName: toolAlias(`${id}/${peer.id}`, tool.name) })));
  }
  current(peer) {
    return !this.closed && this.peers.get(peer.id) === peer && this.connections.active(peer.sender) &&
      this.isDeviceAllowed(peer.sender.config.deviceId) && peer.ws.readyState === 1;
  }
  async accept(ws, sender) {
    ws.on('error', () => {}); // Transport reports a sanitized error after start.
    const peers = [...this.peers.values()].filter(peer => peer.sender === sender);
    if (this.closed || !this.connections.active(sender) || !this.isDeviceAllowed(sender.config.deviceId) || peers.length >= 16 || this.peers.size >= 64) {
      ws.close(1008, 'MCP endpoint unavailable or connection limit reached');
      return;
    }
    const peer = { id: randomUUID(), sender, ws, ready: false, tools: [], pending: 0,
      incoming: new Set(), alive: true, controller: new AbortController(), client: null };
    this.peers.set(peer.id, peer);
    ws.on('pong', () => { peer.alive = true; });
    ws.once('close', () => this.detach(peer));
    peer.heartbeat = setInterval(() => {
      if (!this.current(peer) || !peer.alive) { ws.terminate(); return; }
      peer.alive = false;
      ws.ping();
    }, 30000);
    peer.heartbeat.unref();
    const deadline = setTimeout(() => peer.controller.abort(), TIMEOUT);
    try {
      const Client = this.createClient ? null : require('@modelcontextprotocol/sdk/client/index.js').Client;
      peer.client = this.createClient ? this.createClient() : new Client({ name: 'xiaozhi-endpoint', version: '1.0.0' }, { capabilities: {} });
      peer.transport = new EndpointTransport(ws, (id, args) => this.notify(peer, id, args));
      await peer.client.connect(peer.transport, { timeout: TIMEOUT, signal: peer.controller.signal });
      await this.discover(peer);
      if (!this.current(peer) || peer.controller.signal.aborted) throw new Error('MCP endpoint revoked');
      peer.ready = true;
      await this.onReady(sender.config.deviceId, sender.name);
      this.errors.delete(sender.name);
    } catch {
      if (!this.closed && this.connections.active(sender)) this.errors.set(sender.name, 'MCP endpoint belum siap. Periksa proses MCP dan koneksi agent.');
      await peer.client?.close().catch(() => {});
      this.detach(peer);
      ws.close(1008, 'MCP endpoint initialization failed');
    } finally { clearTimeout(deadline); }
  }
  detach(peer) {
    if (!this.peers.delete(peer.id)) return;
    peer.controller.abort();
    clearInterval(peer.heartbeat);
    if (peer.ready) this.onChanged(peer.sender.config.deviceId, peer.sender.name);
    peer.ready = false;
    peer.tools = [];
  }
  async discover(peer) {
    const tools = [];
    const names = new Set();
    const cursors = new Set();
    let cursor;
    do {
      const page = await peer.client.listTools(cursor ? { cursor } : {}, { timeout: TIMEOUT, signal: peer.controller.signal });
      for (const tool of page.tools) {
        if (tools.length >= MAX_TOOLS || typeof tool.name !== 'string' || !tool.name.trim() || tool.name.length > 128 || names.has(tool.name) ||
            tool.inputSchema?.type !== 'object' || JSON.stringify(tool.inputSchema).length > 8000) throw new Error('Unsupported MCP tool definitions');
        names.add(tool.name);
        tools.push({ name: tool.name, description: String(tool.description || '').slice(0, 1200), inputSchema: tool.inputSchema });
      }
      cursor = page.nextCursor;
      if (cursor && (cursors.has(cursor) || cursors.size >= MAX_TOOLS)) throw new Error('Invalid MCP pagination');
      cursors.add(cursor);
    } while (cursor);
    const others = [...this.peers.values()].filter(other => other !== peer && other.sender === peer.sender);
    if (tools.length + others.reduce((sum, other) => sum + other.tools.length, 0) > MAX_TOOLS) throw new Error('Too many paired MCP tools');
    if (!this.current(peer)) throw new Error('MCP endpoint closed');
    peer.tools = tools;
  }
  routes(ids, deviceId) {
    const routes = new Map();
    for (const peer of this.peers.values()) {
      if (!peer.ready || !this.current(peer) || !ids.has(peer.sender.name) || peer.sender.config.deviceId !== deviceId) continue;
      for (const tool of peer.tools) {
        const name = toolAlias(`${peer.sender.name}/${peer.id}`, tool.name);
        routes.set(name, { peer, name: tool.name, signature: JSON.stringify(tool), connectionId: peer.sender.name,
          definition: { name, description: `${peer.sender.config.name}: ${tool.description}`, parameters: tool.inputSchema } });
      }
    }
    return routes;
  }
  async call(route, args, { deviceId, sessionId, signal }) {
    const peer = route.peer;
    const tool = peer.tools.find(item => item.name === route.name);
    if (!peer.ready || !this.current(peer) || peer.sender.config.deviceId !== deviceId || !tool || JSON.stringify(tool) !== route.signature || !sessionId) throw new Error('MCP endpoint tool is no longer available; reopen the conversation');
    if (!plainObject(args) || JSON.stringify(args).length > 16384) throw new Error('Invalid MCP tool arguments');
    if (peer.pending >= 4) throw new Error('MCP endpoint busy; no action dispatched');
    peer.pending++;
    try {
      const result = await peer.client.callTool({ name: route.name, arguments: args,
        _meta: { 'xiaozhi/device_id': deviceId, 'xiaozhi/session_id': sessionId } }, undefined,
        { timeout: 30000, signal: AbortSignal.any([peer.controller.signal, ...(signal ? [signal] : [])]) });
      return boundedResult(result);
    } catch { throw new Error('MCP tool failed or disconnected; execution outcome is unknown. Do not automatically retry.'); }
    finally { peer.pending--; }
  }
  async notify(peer, id, args) {
    if (!peer.transport) return;
    const reply = value => peer.transport.send({ jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: value.stored !== true
    } }).catch(() => {});
    if (!this.current(peer) || peer.incoming.size >= 4 || peer.incoming.has(id)) {
      await peer.transport.send({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Notification request unavailable or already pending' } }).catch(() => {});
      return;
    }
    peer.incoming.add(id);
    try { await reply(await this.publish(peer.sender, args)); }
    catch (error) { const safe = this.publicError(error); await reply({ stored: safe.stored, error: safe.error }); }
    finally { peer.incoming.delete(id); }
  }
  revoke(id) {
    for (const peer of [...this.peers.values()]) {
      if (peer.sender.name !== id) continue;
      this.detach(peer);
      void peer.client?.close().catch(() => {});
      peer.ws.close(1008, 'Agent connection revoked');
    }
    this.errors.delete(id);
  }
  async close() {
    this.closed = true;
    const peers = [...this.peers.values()];
    for (const peer of peers) this.detach(peer);
    await Promise.all(peers.map(peer => peer.client?.close().catch(() => {})));
  }
}

module.exports = { McpEndpoint, EndpointTransport, MAX_PAYLOAD };
