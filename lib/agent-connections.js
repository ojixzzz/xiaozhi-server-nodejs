'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

const ID = /^agent-[0-9a-f-]{36}$/;
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
const REGISTER_TOOL = Object.freeze({
  name: 'agent_register',
  description: 'Register your agent MCP server for the device paired by the administrator. Automatically enables its tools for that device. Use a URL reachable from the XiaoZhi relay and a separate optional agent-server Bearer token. Does not run an agent task.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['url'], properties: {
    url: { type: 'string', maxLength: 2048 },
    transport: { type: 'string', enum: ['streamable-http', 'sse'], default: 'streamable-http' },
    token: { type: 'string', maxLength: 4096, description: 'Optional separate credential issued by your MCP server; never reuse the XiaoZhi notification token.' }
  } },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
});

function baseUrl(value) {
  let url;
  try { if (typeof value === 'string' && value.length <= 2048) url = new URL(value); } catch { /* Validate below. */ }
  if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw invalid('Enter the public dashboard HTTP(S) URL without credentials, query or fragment');
  }
  return url.href.replace(/\/+$/, '');
}

class AgentConnections {
  constructor({ filename, remoteMcp, resolveDevice, onRegistered, toolsEnabled = () => true }) {
    this.filename = filename;
    this.remoteMcp = remoteMcp;
    this.resolveDevice = resolveDevice;
    this.onRegistered = onRegistered;
    this.toolsEnabled = toolsEnabled;
    this.rows = new Map();
    this.busy = new Set();
    try {
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error('Invalid agent configuration file');
      fs.chmodSync(filename, 0o600);
      const rows = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (!Array.isArray(rows) || rows.length > 16) throw new Error('Invalid agent configuration');
      const tokens = new Set();
      const servers = new Set();
      for (const row of rows) {
        if (!row || Object.keys(row).some(key => !['id', 'name', 'deviceId', 'baseUrl', 'token', 'serverId'].includes(key)) ||
            !ID.test(row.id) || this.rows.has(row.id) || typeof row.deviceId !== 'string' || !DEVICE.test(row.deviceId) ||
            typeof row.name !== 'string' || !row.name.trim() || row.name.length > 80 || /[\x00-\x1f\x7f]/.test(row.name) ||
            !/^[0-9a-f]{64}$/.test(row.token) || tokens.has(row.token) ||
            row.serverId !== null && (!/^remote-[0-9a-f-]{36}$/.test(row.serverId) || servers.has(row.serverId))) throw new Error('Invalid agent configuration');
        tokens.add(row.token);
        if (row.serverId) servers.add(row.serverId);
        row.baseUrl = baseUrl(row.baseUrl);
        this.rows.set(row.id, this.entry(row));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  entry(config) {
    return { config, name: config.id, token: config.token, devices: new Set([config.deviceId]),
      count: 0, windowStart: 0, pending: 0, activeBeeps: 0 };
  }
  persist(rows) {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify([...rows.values()].map(row => row.config), null, 2), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.filename);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  senders() { return [...this.rows.values()]; }
  active(sender) { return this.rows.get(sender.name) === sender; }
  tools(sender) { return this.active(sender) ? [REGISTER_TOOL] : []; }
  list() {
    const servers = this.remoteMcp?.list() || [];
    return [...this.rows.values()].map(({ config }) => {
      const server = servers.find(item => item.id === config.serverId);
      return { id: config.id, name: config.name, device_id: config.deviceId, public_url: config.baseUrl,
        server_id: config.serverId, connected: Boolean(server?.connected), tools_enabled: Boolean(server && this.toolsEnabled(config.deviceId, server.id)), tools_count: server?.tools.length || 0,
        status: server?.connected ? 'connected' : server ? 'offline' : 'waiting', error: server?.error || null };
    });
  }
  async allowed(row) {
    if (!this.active(row)) return false;
    return (await this.resolveDevice(row.config.deviceId))?.status === 'approved' && this.active(row);
  }
  async create(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'device_id', 'public_url'].includes(key))) throw invalid('Invalid agent setup fields');
    if (this.rows.size >= 16) throw invalid('At most 16 agent connections are supported');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) throw invalid('Enter an agent name of 1–80 characters');
    if (typeof input.device_id !== 'string' || !DEVICE.test(input.device_id) || (await this.resolveDevice(input.device_id))?.status !== 'approved') throw invalid('Choose an approved Gemini device with its own token', 409);
    const config = { id: `agent-${randomUUID()}`, name: input.name.trim(), deviceId: input.device_id,
      baseUrl: baseUrl(input.public_url), token: randomBytes(32).toString('hex'), serverId: null };
    // Recheck capacity after the asynchronous approval lookup.
    if (this.rows.size >= 16) throw invalid('At most 16 agent connections are supported');
    const rows = new Map(this.rows);
    rows.set(config.id, this.entry(config));
    this.persist(rows);
    this.rows = rows;
    return { connection: this.list().find(row => row.id === config.id), ...this.export(config.id) };
  }
  export(id) {
    const row = this.rows.get(id);
    if (!row) throw invalid('Agent connection not found', 404);
    const config = row.config;
    const mcpConfig = { mcpServers: { xiaozhi: { url: `${config.baseUrl}/mcp/notifications`,
      headers: { Authorization: `Bearer ${config.token}` } } } };
    const instructions = [
      'Hubungkan agent ini dengan XiaoZhi untuk notifikasi inbox dan tools dua arah.',
      'Tambahkan koneksi MCP Streamable HTTP berikut ke konfigurasi MCP client kamu (sesuaikan format hanya jika aplikasi memerlukannya):',
      JSON.stringify(mcpConfig, null, 2),
      `Perangkat yang diizinkan: ${JSON.stringify(config.deviceId)}. Token ini hanya untuk koneksi ke XiaoZhi; jangan masukkan ke log, repo, atau gunakan sebagai token server agent.`,
      'Untuk koneksi balik, jalankan MCP server milik agent yang menyediakan tools tugas/status/balasan, lalu panggil tool agent_register melalui koneksi xiaozhi dengan {"url":"URL_MCP_SERVER_AGENT","transport":"streamable-http","token":"TOKEN_SERVER_AGENT_JIKA_DIPERLUKAN"}. Ganti placeholder dengan endpoint nyata yang dapat diakses relay; gunakan token berbeda dan hilangkan field token jika server tidak memerlukannya. Tools otomatis aktif untuk perangkat ini.',
      'Jika aplikasi ini hanya mendukung MCP client, siapkan MCP server/adaptor terlebih dahulu dan laporkan bagian yang belum tersedia. Jangan mengklaim koneksi dua arah berhasil sebelum agent_register mengembalikan connected:true.',
      `Kirim hasil tugas atau pesan dengan notify_send: ${JSON.stringify({ device_id: config.deviceId, title: 'Judul singkat', text: 'Isi hasil atau pesan', idempotency_key: 'ID_UNIK_PER_PESAN' })}. Simpan notification_id untuk korelasi balasan. Ulangi request yang belum pasti hanya dengan key dan isi yang sama.`,
      'Saat tools agent dipanggil oleh XiaoZhi, ambil perangkat dari _meta["xiaozhi/device_id"] dan sesi dari _meta["xiaozhi/session_id"], batasi ke perangkat di atas. Untuk tugas lama, kembalikan job_id dengan status accepted dalam 30 detik, lalu kirim hasil lewat notify_send.',
      'Inbox tersimpan sebelum beep. Beep berulang sampai read; saat pengguna menyapa, XiaoZhi membacakan judul terlebih dahulu. Jangan mengirim pesan percobaan tanpa diminta pengguna.'
    ].join('\n\n');
    return { mcp_config: mcpConfig, instructions };
  }
  async register(sender, input) {
    if (!await this.allowed(sender)) throw invalid('Agent device is no longer approved', 403);
    if (!this.remoteMcp) throw invalid('Remote MCP configuration is unavailable', 503);
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['url', 'transport', 'token'].includes(key)) ||
        input.token !== undefined && (typeof input.token !== 'string' || input.token === sender.token)) throw invalid('Use a separate agent-server token and only url, transport, token fields');
    if (this.busy.has(sender.name)) throw invalid('Agent connection is being updated; check status before retrying', 409);
    if (!this.active(sender)) throw invalid('Agent connection has been revoked', 403);
    this.busy.add(sender.name);
    try {
      const previous = this.remoteMcp.list().find(item => item.id === sender.config.serverId);
      const settings = { ...(previous ? { id: previous.id } : {}), name: sender.config.name,
        url: input.url, transport: input.transport || 'streamable-http', enabled: true, ...(input.token !== undefined ? { token: input.token } : {}) };
      const server = await this.remoteMcp.save(settings);
      const previousConfig = sender.config;
      sender.config = { ...previousConfig, serverId: server.id };
      try { this.persist(this.rows); }
      catch (error) {
        sender.config = previousConfig;
        if (!previous) await this.remoteMcp.remove(server.id).catch(() => {});
        throw error;
      }
      // Approval may have changed during discovery; never select a revoked device.
      if (!await this.allowed(sender)) throw invalid('Agent device is no longer approved', 403);
      await this.onRegistered(sender.config.deviceId, server.id);
      return { registered: true, connected: server.connected, device_id: sender.config.deviceId,
        tools_count: server.tools.length, ...(server.error ? { error: server.error } : {}),
        message: server.connected ? 'Tools enabled. Reopen the XiaoZhi conversation.' : 'Endpoint saved; connection is offline. The relay will retry discovery.' };
    } finally { this.busy.delete(sender.name); }
  }
  async remove(id) {
    const row = this.rows.get(id);
    if (!row) throw invalid('Agent connection not found', 404);
    if (this.busy.has(id)) throw invalid('Agent connection is being updated; try again after it finishes', 409);
    this.busy.add(id);
    try {
      if (this.remoteMcp?.list().some(server => server.id === row.config.serverId)) await this.remoteMcp.remove(row.config.serverId);
      const rows = new Map(this.rows);
      rows.delete(id);
      this.persist(rows);
      this.rows = rows;
      return row.config.serverId;
    } finally { this.busy.delete(id); }
  }
}

module.exports = { AgentConnections, REGISTER_TOOL };
