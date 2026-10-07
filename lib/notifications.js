'use strict';

const { createHash, randomUUID } = require('node:crypto');

// Application limits, not claims about the firmware's maximum capabilities.
const LIMITS = Object.freeze({
  urlBytes: 2048,
  subtitles: 64,
  subtitleBytes: 512,
  payloadBytes: 8192,
  subtitleStartMs: 600000,
  maxFutureMs: 600000
});

class NotificationError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new NotificationError(code, message, statusCode);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function strictKeys(value, allowed) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    fail('INVALID_INPUT', 'Unexpected notification fields');
  }
}

function identifier(value, label, max = 256) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max ||
      !/^[A-Za-z0-9_.:@/-]+$/.test(value) ||
      ['__proto__', 'prototype', 'constructor'].includes(value)) {
    fail('INVALID_INPUT', `${label} is invalid`);
  }
  return value;
}

function normalizeOrigins(origins, allowHttp) {
  if (!Array.isArray(origins) || origins.length > 32) {
    fail('INVALID_CONFIG', 'Audio origins must be an array of at most 32 origins', 503);
  }
  return new Set(origins.map(origin => {
    let parsed;
    try { parsed = new URL(origin); } catch { /* rejected below */ }
    if (typeof origin !== 'string' || /[\s\\?#]/.test(origin) || !parsed ||
        !['https:', ...(allowHttp ? ['http:'] : [])].includes(parsed.protocol) ||
        parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.pathname !== '/' || !parsed.hostname) {
      fail('INVALID_CONFIG', 'Each audio origin must be an exact HTTPS origin (HTTP requires explicit opt-in)', 503);
    }
    return parsed.origin;
  }));
}

function validateNotifyPayload(input, { allowedAudioOrigins = [], allowHttp = false } = {}) {
  strictKeys(input, ['type', 'audio_url', 'subtitles']);
  if (input.type !== undefined && input.type !== 'notify') {
    fail('INVALID_INPUT', 'Only notify messages are supported');
  }
  const origins = normalizeOrigins(allowedAudioOrigins, allowHttp);
  let url;
  if (typeof input.audio_url !== 'string' || input.audio_url.length === 0 ||
      Buffer.byteLength(input.audio_url) > LIMITS.urlBytes || /[\s\\\u0000-\u001f\u007f]/.test(input.audio_url)) {
    fail('INVALID_AUDIO_URL', 'audio_url must be a bounded absolute HTTP(S) URL');
  }
  try { url = new URL(input.audio_url); } catch { /* rejected below */ }
  if (!url || !['https:', ...(allowHttp ? ['http:'] : [])].includes(url.protocol) ||
      url.username || url.password || input.audio_url.includes('#') || !origins.has(url.origin)) {
    fail('INVALID_AUDIO_URL', 'audio_url must use an allowed origin, without credentials or a fragment');
  }
  // Do not fetch/proxy this URL, resolve DNS, or turn validation into an SSRF endpoint.
  const payload = { type: 'notify', audio_url: input.audio_url };
  if (input.subtitles !== undefined) {
    if (!Array.isArray(input.subtitles) || input.subtitles.length > LIMITS.subtitles) {
      fail('INVALID_SUBTITLES', `At most ${LIMITS.subtitles} subtitles are allowed`);
    }
    payload.subtitles = input.subtitles.map(entry => {
      strictKeys(entry, ['start_ms', 'text']);
      if (!Number.isSafeInteger(entry.start_ms) || entry.start_ms < 0 ||
          entry.start_ms > LIMITS.subtitleStartMs || typeof entry.text !== 'string' ||
          !entry.text.trim() || Buffer.byteLength(entry.text) > LIMITS.subtitleBytes ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.text)) {
        fail('INVALID_SUBTITLES', 'Subtitles require bounded non-empty text and an integer start_ms from 0 to 600000');
      }
      return { start_ms: entry.start_ms, text: entry.text };
    }).sort((a, b) => a.start_ms - b.start_ms);
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > LIMITS.payloadBytes) {
    fail('PAYLOAD_TOO_LARGE', `Notification JSON must not exceed ${LIMITS.payloadBytes} bytes`, 413);
  }
  return payload;
}

function boundedInteger(value, fallback, min, max, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    fail('INVALID_CONFIG', `${name} must be an integer from ${min} to ${max}`, 503);
  }
  return resolved;
}

function validateRpcAdapter(adapter) {
  if (!adapter || typeof adapter.rpc !== 'function') {
    fail('INVALID_CONFIG', 'Notification adapter must export a function named rpc', 503);
  }
  return adapter.rpc.bind(adapter);
}

class NotificationService {
  constructor({ enabled = false, rpc, resolveDevice, resolveClientId, transport = 'xz-mqtt-redis-rpc', clientIds = {}, allowedAudioOrigins = [],
    allowHttp = false, timeoutMs, dedupeTtlMs, maxEntries, maxPending, minIntervalMs,
    now = Date.now } = {}) {
    if (typeof enabled !== 'boolean' || typeof allowHttp !== 'boolean' || typeof now !== 'function') {
      fail('INVALID_CONFIG', 'Invalid notification configuration types', 503);
    }
    if (rpc !== undefined && typeof rpc !== 'function') {
      fail('INVALID_CONFIG', 'rpc must be a function', 503);
    }
    if (resolveDevice !== undefined && typeof resolveDevice !== 'function') {
      fail('INVALID_CONFIG', 'resolveDevice must be a function', 503);
    }
    if (!plainObject(clientIds) || Object.keys(clientIds).length > 1000) {
      fail('INVALID_CONFIG', 'clientIds must be a bounded device-to-client-ID object', 503);
    }
    this.clientIds = new Map();
    const destinations = new Set();
    for (const [deviceId, clientId] of Object.entries(clientIds)) {
      try {
        identifier(deviceId, 'Device ID', 128);
        identifier(clientId, 'MQTT client ID');
      } catch {
        fail('INVALID_CONFIG', 'Invalid device-to-client-ID mapping', 503);
      }
      if (destinations.has(clientId)) {
        fail('INVALID_CONFIG', 'Each MQTT client ID must map to exactly one device', 503);
      }
      destinations.add(clientId);
      this.clientIds.set(deviceId, clientId);
    }
    this.enabled = enabled;
    this.rpc = rpc;
    this.resolveDevice = resolveDevice;
    if (resolveClientId !== undefined && typeof resolveClientId !== 'function') fail('INVALID_CONFIG', 'resolveClientId must be a function', 503);
    this.resolveClientId = resolveClientId;
    this.transport = transport;
    this.allowHttp = allowHttp;
    this.allowedAudioOrigins = [...normalizeOrigins(allowedAudioOrigins, allowHttp)];
    this.timeoutMs = boundedInteger(timeoutMs, 5000, 1, 30000, 'timeoutMs');
    this.dedupeTtlMs = boundedInteger(dedupeTtlMs, 600000, 1000, 86400000, 'dedupeTtlMs');
    this.maxEntries = boundedInteger(maxEntries, 1000, 1, 10000, 'maxEntries');
    this.maxPending = boundedInteger(maxPending, 16, 1, 64, 'maxPending');
    this.minIntervalMs = boundedInteger(minIntervalMs, 1000, 0, this.dedupeTtlMs, 'minIntervalMs');
    this.now = now;
    this.records = new Map();
    this.pending = 0;
  }

  status() {
    const missing = [];
    if (!this.rpc) missing.push('adapter');
    if (!this.resolveDevice) missing.push('device_resolver');
    if (this.clientIds.size === 0 && !this.resolveClientId) missing.push('client_id_mapping');
    if (this.allowedAudioOrigins.length === 0) missing.push('audio_origins');
    return {
      enabled: this.enabled,
      configured: missing.length === 0,
      transport: this.transport,
      missing,
      playbackAcknowledgement: false
    };
  }

  async send(deviceId, input, context) {
    if (!this.enabled) fail('NOTIFICATIONS_DISABLED', 'Notifications are disabled', 503);
    if (!this.status().configured) fail('NOTIFICATIONS_NOT_CONFIGURED', 'Notification gateway is not configured', 503);
    identifier(deviceId, 'Device ID', 128);
    strictKeys(input, ['audio_url', 'subtitles', 'idempotencyKey', 'expiresAt']);
    const payloadInput = { audio_url: input.audio_url };
    if (input.subtitles !== undefined) payloadInput.subtitles = input.subtitles;
    const payload = validateNotifyPayload(payloadInput, this);
    const requestedExpiry = input.expiresAt;
    const expiresAt = requestedExpiry === undefined ? this.now() + 30000 : requestedExpiry;
    if (!Number.isSafeInteger(expiresAt) || expiresAt > this.now() + LIMITS.maxFutureMs) {
      fail('INVALID_EXPIRY', 'expiresAt must be epoch milliseconds no more than 10 minutes ahead');
    }
    if (expiresAt <= this.now()) fail('NOTIFICATION_EXPIRED', 'Notification has expired', 410);
    const idempotencyKey = input.idempotencyKey;
    if (idempotencyKey !== undefined) identifier(idempotencyKey, 'Idempotency key', 128);

    // The application authenticates the principal and resolves only its owned devices.
    // Approval and the explicit deployment mapping are separate mandatory checks.
    const device = await this.resolveDevice(deviceId, context);
    const clientId = this.resolveClientId ? await this.resolveClientId(deviceId, device, context) : this.clientIds.get(deviceId);
    if (!device || device.status !== 'approved' || !clientId) {
      fail('DESTINATION_NOT_ALLOWED', 'An owned, approved, explicitly mapped device is required', 403);
    }
    identifier(clientId, 'MQTT client ID');
    if (expiresAt <= this.now()) fail('NOTIFICATION_EXPIRED', 'Notification has expired', 410);

    const currentTime = this.now();
    for (const [key, record] of this.records) {
      if (record.completed && record.retainUntil <= currentTime) this.records.delete(key);
    }
    const key = JSON.stringify([deviceId, idempotencyKey || randomUUID()]);
    const fingerprint = createHash('sha256').update(JSON.stringify([clientId, payload, requestedExpiry])).digest('hex');
    const previous = this.records.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        fail('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for different notification content', 409);
      }
      return { ...await previous.result, duplicate: true };
    }
    if (this.pending >= this.maxPending || this.records.size >= this.maxEntries) {
      fail('NOTIFICATION_CAPACITY', 'Notification capacity reached; no message was queued', 429);
    }
    for (const record of this.records.values()) {
      if (record.deviceId === deviceId && currentTime - record.createdAt < this.minIntervalMs) {
        fail('NOTIFICATION_RATE_LIMIT', 'Please wait before sending another notification to this device', 429);
      }
    }

    const record = {
      deviceId, fingerprint, createdAt: currentTime, completed: false,
      retainUntil: currentTime + this.dedupeTtlMs
    };
    this.records.set(key, record);
    const id = randomUUID();
    // forward reserves a pending slot synchronously but invokes rpc in a microtask,
    // after the record promise exists. Concurrent retries can safely join it.
    record.result = this.forward(clientId, payload, expiresAt, id);
    record.result = record.result.finally(() => {
      record.completed = true;
      record.retainUntil = this.now() + this.dedupeTtlMs;
    });
    return { ...await record.result, duplicate: false };
  }

  async forward(clientId, payload, expiresAt, id) {
    if (expiresAt <= this.now()) {
      return { id, status: 'not_published', reason: 'expired_before_forward', playback: 'unknown' };
    }
    const controller = new AbortController();
    let timer;
    this.pending++;
    const operation = Promise.resolve().then(() => this.rpc({
      method: 'forward', clientId, params: payload
    }, { signal: controller.signal }));
    // Keep unresolved transport work counted after a timeout; an adapter ignoring abort
    // must not create unbounded outstanding operations on repeated requests.
    const settled = operation.then(
      result => { this.pending--; return { result }; },
      () => { this.pending--; return { error: true }; }
    );
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        resolve({ timeout: true });
        controller.abort();
      }, Math.min(this.timeoutMs, Math.max(1, expiresAt - this.now())));
    });
    let outcome;
    try { outcome = await Promise.race([settled, timeout]); } finally { clearTimeout(timer); }
    if (outcome.result && outcome.result.success === true) {
      return { id, status: 'published', reason: 'gateway_write_confirmed', playback: 'unknown' };
    }
    if (outcome.result && outcome.result.success === false) {
      return { id, status: 'not_published', reason: 'gateway_did_not_publish', playback: 'unknown' };
    }
    // Exceptions/timeouts may occur after a write. Never turn uncertainty into a retry
    // or claim the device was offline, received the message, or played its audio.
    return {
      id, status: 'unknown',
      reason: outcome.timeout ? 'gateway_timeout' : outcome.error ? 'gateway_error' : 'unrecognized_gateway_result',
      playback: 'unknown'
    };
  }
}

function fromEnvironment(env = process.env, { rpc, resolveDevice, ...options } = {}) {
  function boolean(name) {
    if (env[name] === undefined || env[name] === '' || env[name] === 'false') return false;
    if (env[name] === 'true') return true;
    fail('INVALID_CONFIG', `${name} must be true or false`, 503);
  }
  let clientIds = {};
  try { clientIds = JSON.parse(env.NOTIFY_CLIENT_IDS_JSON || '{}'); } catch {
    fail('INVALID_CONFIG', 'NOTIFY_CLIENT_IDS_JSON must be a JSON object', 503);
  }
  const timeout = env.NOTIFY_TIMEOUT_MS;
  if (timeout !== undefined && !/^\d+$/.test(timeout)) {
    fail('INVALID_CONFIG', 'NOTIFY_TIMEOUT_MS must be an integer', 503);
  }
  return new NotificationService({
    ...options,
    enabled: boolean('NOTIFY_ENABLED'),
    allowHttp: boolean('NOTIFY_ALLOW_HTTP'),
    clientIds,
    allowedAudioOrigins: (env.NOTIFY_ALLOWED_AUDIO_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean),
    timeoutMs: timeout === undefined ? undefined : Number(timeout),
    rpc, resolveDevice
  });
}

module.exports = { NotificationService, NotificationError, fromEnvironment, validateRpcAdapter, validateNotifyPayload, LIMITS };
