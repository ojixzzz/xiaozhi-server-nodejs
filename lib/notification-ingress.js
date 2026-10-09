'use strict';

const express = require('express');
const { validSecret, safeEqual } = require('./mqtt-integration');

const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18']);
const LIMITS = Object.freeze({ senders: 32, devicesPerSender: 64, title: 120, text: 2000, key: 128, bodyBytes: 16384 });
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/;
const SENDER_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+=*$/;
const BEEP_STATUSES = new Set(['published', 'not_published', 'unknown']);
const ROUTES = ['/api/notifications', '/mcp/notifications'];
// The prefix is not a valid external sender name, so an external token can never
// impersonate the dashboard's durable idempotency namespace.
const ADMIN_SENDER = '@dashboard-admin';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:@/-]{1,128}$/;
const RETRY_TTL_MS = 10 * 60 * 1000;
const MAX_RETRY_ATTEMPTS = 1024;

class IngressError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}
const fail = (code, message, statusCode) => { throw new IngressError(code, message, statusCode); };
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeId = value => typeof value === 'string' && DEVICE_ID.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);

function integer(value, fallback, minimum, maximum) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    fail('INGRESS_CONFIG_INVALID', 'Invalid notification ingress limit', 503);
  }
  return number;
}

function limits(env, safeDefaults = false) {
  const read = (key, fallback, min, max) => {
    try { return integer(env[key], fallback, min, max); }
    catch (error) { if (!safeDefaults) throw error; return fallback; }
  };
  return {
    rate: read('NOTIFY_INGRESS_RATE_PER_MINUTE', 60, 1, 600),
    maxPending: read('NOTIFY_INGRESS_MAX_PENDING', 4, 1, 32),
    beepTimeoutMs: read('NOTIFY_INGRESS_BEEP_TIMEOUT_MS', 15000, 1000, 30000)
  };
}

function settings(env) {
  let rows;
  try { rows = JSON.parse(env.NOTIFY_SENDERS_JSON || '[]'); }
  catch { fail('INGRESS_CONFIG_INVALID', 'NOTIFY_SENDERS_JSON must be a JSON array', 503); }
  if (!Array.isArray(rows) || rows.length > LIMITS.senders) {
    fail('INGRESS_CONFIG_INVALID', 'Invalid notification sender configuration', 503);
  }
  const names = new Set();
  const tokens = new Set();
  const reservedNames = ['MQTT_SIGNATURE_KEY', 'MQTT_GATEWAY_KEY', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'CLIENT_AUTH_TOKEN', 'GEMINI_API_KEY', 'DASHSCOPE_API_KEY'];
  const reservedSecrets = reservedNames.map(name => env[name]).filter(Boolean);
  const senders = rows.map(row => {
    if (!plainObject(row) || Object.keys(row).some(key => !['name', 'token_env', 'device_ids'].includes(key)) ||
        typeof row.name !== 'string' || !SENDER_ID.test(row.name) || names.has(row.name) ||
        typeof row.token_env !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(row.token_env) || reservedNames.includes(row.token_env) ||
        !Array.isArray(row.device_ids) || row.device_ids.length < 1 || row.device_ids.length > LIMITS.devicesPerSender ||
        row.device_ids.some(id => !safeId(id)) || new Set(row.device_ids).size !== row.device_ids.length) {
      fail('INGRESS_CONFIG_INVALID', 'Each sender needs a unique name, token_env and exact device_ids', 503);
    }
    const token = env[row.token_env];
    if (!validSecret(token) || !BEARER_TOKEN.test(token) || tokens.has(token) || reservedSecrets.includes(token)) {
      fail('INGRESS_CONFIG_INVALID', 'Sender tokens must be distinct operator-provided bearer secrets of 32–512 characters', 503);
    }
    names.add(row.name); tokens.add(token);
    return { name: row.name, token, devices: new Set(row.device_ids), count: 0, windowStart: 0, pending: 0, activeBeeps: 0 };
  });
  const origins = new Set();
  const rawOrigins = (env.NOTIFY_INGRESS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (rawOrigins.length > 32) fail('INGRESS_CONFIG_INVALID', 'Too many ingress origins', 503);
  for (const origin of rawOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { /* validated below */ }
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin ||
        parsed.username || parsed.password) {
      fail('INGRESS_CONFIG_INVALID', 'Ingress origins must be exact HTTP(S) origins without paths', 503);
    }
    origins.add(origin);
  }
  return { senders, origins, ...limits(env) };
}

function validateInput(input) {
  if (!plainObject(input) || Object.keys(input).some(key => !['device_id', 'title', 'text', 'idempotency_key'].includes(key))) {
    fail('INVALID_INPUT', 'Only device_id, title, text and idempotency_key are accepted');
  }
  if (!safeId(input.device_id)) fail('INVALID_INPUT', 'device_id must be an exact configured device ID');
  const title = input.title === undefined ? '' : input.title;
  if (typeof title !== 'string' || !title.isWellFormed() || title.length > LIMITS.title || /[\u0000-\u001f\u007f]/.test(title)) {
    fail('INVALID_INPUT', 'title must be at most 120 characters without control characters');
  }
  if (typeof input.text !== 'string' || !input.text.isWellFormed() || !input.text.trim() || input.text.length > LIMITS.text ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.text)) {
    fail('INVALID_INPUT', 'text must be non-empty and at most 2000 characters');
  }
  if (typeof input.idempotency_key !== 'string' || !IDENTIFIER.test(input.idempotency_key)) {
    fail('INVALID_INPUT', 'idempotency_key is required and must be 1–128 identifier characters');
  }
  if (Buffer.byteLength(JSON.stringify(input)) > LIMITS.bodyBytes) fail('PAYLOAD_TOO_LARGE', 'Notification body is too large', 413);
  return { deviceId: input.device_id, title, text: input.text, idempotencyKey: input.idempotency_key };
}

const ERROR_MAP = Object.freeze({
  INBOX_CAPACITY: [429, 'The device inbox is full'],
  INBOX_BACKPRESSURE: [503, 'The notification inbox is busy'],
  INBOX_IDEMPOTENCY_CONFLICT: [409, 'This idempotency key was already used for different content'],
  INBOX_CLOSED: [503, 'The notification inbox is unavailable'],
  INBOX_CORRUPT: [503, 'The notification inbox is unavailable']
});
function publicError(error) {
  if (error instanceof IngressError) return { status: error.statusCode, stored: false, error: { code: error.code, message: error.message } };
  const entry = Object.hasOwn(ERROR_MAP, error?.code || '') ? ERROR_MAP[error.code] : null;
  if (entry) return { status: entry[0], stored: false, error: { code: error.code, message: entry[1] } };
  return { status: 503, stored: null, error: { code: 'INGRESS_UNAVAILABLE', message: 'The notification operation could not be confirmed; retry with the same idempotency key' } };
}
function rpcError(res, id, code, message, status = 400) {
  return res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

const TOOL = Object.freeze({
  name: 'notify_send',
  description: 'Store a text notification for an explicitly allowed device and attempt a short chime. Title: at most 120 JavaScript UTF-16 code units; text: at most 2000. Oversized messages are rejected, not automatically truncated. Device quiet hours suppress chimes while storage continues. The user can request the stored text later. Does not execute instructions, read messages, or speak notification text.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['device_id', 'text', 'idempotency_key'],
    properties: {
      device_id: { type: 'string', minLength: 1, maxLength: 128 },
      title: { type: 'string', maxLength: LIMITS.title },
      text: { type: 'string', minLength: 1, maxLength: LIMITS.text },
      idempotency_key: { type: 'string', minLength: 1, maxLength: LIMITS.key, pattern: '^[A-Za-z0-9_.:@/-]+$' }
    }
  },
  outputSchema: {
    type: 'object', additionalProperties: false, required: ['stored'],
    properties: {
      stored: { type: ['boolean', 'null'] },
      notification_id: { type: 'string', maxLength: 128 },
      device_id: { type: 'string', maxLength: 128 },
      duplicate: { type: 'boolean' },
      beep: { type: 'object', additionalProperties: false, required: ['status', 'playback'], properties: {
        status: { type: 'string', enum: ['published', 'not_published', 'unknown'] },
        playback: { const: 'unknown' }
      } },
      beep_status_persisted: { type: 'boolean' },
      error: { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
        code: { type: 'string', maxLength: 64 }, message: { type: 'string', maxLength: 240 }
      } }
    }
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
});

/** Mount at / before browser session/auth/CORS middleware. Never creates tokens.
 * inbox is durable; ingress attempts one bounded chime without retrying the
 * sender request. The application separately schedules unread reminders.
 * No notification text is returned to a sender or passed to an LLM here.
 */
function createNotificationIngress({ env = process.env, inbox, resolveDevice, beep, now = Date.now,
  additionalSenders = () => [], additionalTools = () => [], callAdditionalTool } = {}) {
  const router = express.Router();
  let config; let configurationError;
  // Dashboard authorization belongs to the parent's session/CSRF routes. It has
  // no external bearer credential and must work when external ingress is off or
  // misconfigured. Invalid external limits fall back to bounded safe defaults.
  const adminLimits = limits(env, true);
  const admin = { name: ADMIN_SENDER, devices: null, count: 0, windowStart: 0, pending: 0, activeBeeps: 0 };
  const retryAttempts = new Map();
  function requireAdapters(retry = false) {
    if (!inbox || typeof inbox.enqueue !== 'function' || typeof inbox.updateBeep !== 'function' ||
        retry && typeof inbox.get !== 'function' || typeof resolveDevice !== 'function' ||
        typeof beep !== 'function' || typeof now !== 'function') {
      fail('INGRESS_CONFIG_INVALID', 'Notification inbox, approved-device resolver and chime adapter are required', 503);
    }
  }
  try {
    config = settings(env);
    if (config.senders.length) requireAdapters();
  } catch (error) {
    configurationError = error instanceof IngressError ? error : new IngressError('INGRESS_CONFIG_INVALID', 'Invalid notification ingress configuration', 503);
  }
  const senders = () => [...(config?.senders || []), ...additionalSenders()];
  router.status = () => ({ enabled: Boolean(senders().length), configured: Boolean(senders().length && !configurationError),
    invalidConfiguration: Boolean(configurationError),
    reason: configurationError?.message || (senders().length ? null : 'No notification senders are configured') });

  function gate(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (configurationError) return res.status(503).json({ stored: false, error: { code: configurationError.code, message: configurationError.message } });
    const currentSenders = senders();
    if (!currentSenders.length) return res.status(404).json({ stored: false, error: { code: 'INGRESS_DISABLED', message: 'Notification ingress is disabled' } });
    // Headless clients omit Origin. Every supplied Origin must be explicitly allowed.
    const origin = req.get('Origin');
    if (origin !== undefined && !config.origins.has(origin)) return res.status(403).json({ stored: false, error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Origin is not allowed' } });
    const authorization = req.get('Authorization') || '';
    const match = authorization.match(/^Bearer ([A-Za-z0-9._~+/-]+=*)$/i);
    let sender;
    if (match && match[1].length <= 512) {
      // Compare all configured entries; do not use admin cookies or client-asserted sender names.
      for (const candidate of currentSenders) if (safeEqual(match[1], candidate.token)) sender = candidate;
    }
    if (!sender) {
      res.set('WWW-Authenticate', 'Bearer realm="notification-ingress"');
      return res.status(401).json({ stored: false, error: { code: 'UNAUTHORIZED', message: 'A configured sender bearer token is required' } });
    }
    req.notificationSender = sender;
    next();
  }
  function contentType(req, res, next) {
    if (req.method === 'POST' && !req.is('application/json')) {
      return res.status(415).json({ stored: false, error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json' } });
    }
    next();
  }
  // Limit parsing here even when used as a standalone router. The parent must not
  // mount a more permissive parser or CORS handler ahead of this ingress.
  router.use(ROUTES, gate, contentType, express.json({ limit: LIMITS.bodyBytes, strict: true, inflate: false }));

  function receipt(deviceId, notification, duplicate, status, persisted, retry = false) {
    return { stored: true, notification_id: notification.id, device_id: deviceId, duplicate: Boolean(duplicate),
      beep: { status, playback: 'unknown' }, beep_status_persisted: persisted, ...(retry ? { retry: true } : {}) };
  }
  async function allowed(sender, deviceId) {
    const active = () => sender === admin || senders().includes(sender);
    return active() && (!sender.devices || sender.devices.has(deviceId)) &&
      (await resolveDevice(deviceId, { sender: sender.name }))?.status === 'approved' && active();
  }
  async function withPermit(sender, policy, operation) {
    const time = now();
    if (time - sender.windowStart >= 60000 || time < sender.windowStart) { sender.windowStart = time; sender.count = 0; }
    if (sender.count >= policy.rate) fail('SENDER_RATE_LIMITED', 'Sender rate limit reached; retry later with the same idempotency key', 429);
    if (sender.pending >= policy.maxPending || sender.activeBeeps >= policy.maxPending) fail('SENDER_BUSY', 'Too many pending sends for this sender; retry later with the same idempotency key', 429);
    sender.count++;
    sender.pending++;
    try { return await operation(); }
    finally { sender.pending--; }
  }
  async function persistBeep(deviceId, notification, status, reason) {
    try { return Boolean(await inbox.updateBeep(deviceId, notification.id, { status, reason })); }
    catch { return false; }
  }
  // The only chime side-effect path, used by both new notifications and explicit
  // administrator retries. It never enqueues or marks a notification as read.
  async function attemptBeep(sender, policy, deviceId, notification, options) {
    let stillAllowed = false;
    try { stillAllowed = await allowed(sender, deviceId); }
    catch { /* No publication when current approval cannot be established. */ }
    if (!stillAllowed || sender.activeBeeps >= policy.maxPending) {
      return { status: 'not_published', persisted: await persistBeep(deviceId, notification, 'not_published',
        stillAllowed ? 'sender_beep_busy' : 'destination_revoked') };
    }
    // Reserve before awaiting the marker write. Timed-out callbacks retain this
    // slot until they actually settle, including across rate-window resets.
    sender.activeBeeps++;
    const marked = await persistBeep(deviceId, notification, 'unknown', options ? 'retry_attempt_started' : 'attempt_started');
    if (!marked) {
      sender.activeBeeps--;
      return { status: 'not_published', persisted: false };
    }
    // Approval can also be revoked during the durable marker write.
    try { stillAllowed = await allowed(sender, deviceId); } catch { stillAllowed = false; }
    if (!stillAllowed) {
      sender.activeBeeps--;
      return { status: 'not_published', persisted: await persistBeep(deviceId, notification, 'not_published', 'destination_revoked') };
    }
    let status = 'unknown';
    let timer;
    const operation = Promise.resolve().then(() => beep(deviceId, notification, options));
    const settled = operation.then(
      result => { sender.activeBeeps--; return result; },
      error => { sender.activeBeeps--; throw error; }
    );
    try {
      const result = await Promise.race([
        settled,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Chime result timeout')), policy.beepTimeoutMs); })
      ]);
      status = BEEP_STATUSES.has(result?.status) ? result.status : 'unknown';
    } catch { status = 'unknown'; }
    finally { clearTimeout(timer); }
    return { status, persisted: await persistBeep(deviceId, notification, status,
      status === 'unknown' ? 'publication_unconfirmed' : 'attempt_finished') };
  }
  async function send(sender, input, policy = config) {
    const scopedInput = sender.defaultDeviceId && plainObject(input) && input.device_id === undefined ?
      { ...input, device_id: sender.defaultDeviceId } : input;
    const value = validateInput(scopedInput);
    requireAdapters();
    return withPermit(sender, policy, async () => {
      if (!await allowed(sender, value.deviceId)) fail('DESTINATION_NOT_ALLOWED', 'The destination is not allowed', 403);
      const { notification, duplicate } = await inbox.enqueue(value.deviceId, {
        sender: sender.name, title: value.title, text: value.text, idempotencyKey: value.idempotencyKey
      });
      if (!notification || typeof notification.id !== 'string' || notification.id.length > 128) throw new Error('Invalid inbox response');
      if (duplicate) return receipt(value.deviceId, notification, true,
        BEEP_STATUSES.has(notification.beep?.status) ? notification.beep.status : 'unknown', true);
      const result = await attemptBeep(sender, policy, value.deviceId, notification);
      return receipt(value.deviceId, notification, false, result.status, result.persisted);
    });
  }

  // Internal methods only: deliberately do not register unauthenticated HTTP or
  // MCP admin endpoints. Parent routes must require the admin session and CSRF.
  router.publicError = publicError;
  router.publishAdmin = input => send(admin, input, adminLimits);
  router.publishSender = (sender, input) => {
    if (configurationError) throw configurationError;
    if (!senders().includes(sender)) fail('UNAUTHORIZED', 'Sender is no longer configured', 401);
    return send(sender, input);
  };
  router.retryAdminBeep = async (deviceId, notificationId, options) => {
    if (!safeId(deviceId) || typeof notificationId !== 'string' || !UUID.test(notificationId) ||
        !plainObject(options) || Object.keys(options).some(key => !['attemptId', 'confirm'].includes(key)) ||
        options.confirm !== true || typeof options.attemptId !== 'string' || !IDENTIFIER.test(options.attemptId)) {
      fail('INVALID_INPUT', 'An exact device, notification UUID, attemptId and confirm:true are required');
    }
    requireAdapters(true);
    const time = now();
    for (const [key, entry] of retryAttempts) {
      if (entry.expiresAt <= time) retryAttempts.delete(key);
    }
    const attemptId = options.attemptId;
    const key = JSON.stringify([deviceId, notificationId, attemptId]);
    const previous = retryAttempts.get(key);
    if (previous) {
      // This exact attempt is already in flight or complete. Rechecking current
      // approval is read-only; never regenerate an audio URL or a publication.
      if (!await allowed(admin, deviceId)) fail('DESTINATION_NOT_ALLOWED', 'The destination is not allowed', 403);
      const result = await previous.promise;
      return { ...result, beep: { ...result.beep }, duplicate: true };
    }
    if (retryAttempts.size >= MAX_RETRY_ATTEMPTS) fail('RETRY_CACHE_BUSY', 'Too many recent chime attempts; retry later with the same attemptId', 429);
    const entry = { expiresAt: Infinity, promise: null, attemptStarted: false };
    // Set before any asynchronous work so concurrent identical attempts share
    // one operation. This bounded cache is best-effort and does not survive a
    // process restart. The parent UI must warn that unknown retries may repeat.
    retryAttempts.set(key, entry);
    entry.promise = withPermit(admin, adminLimits, async () => {
      const notification = await inbox.get(deviceId, notificationId);
      if (!notification) fail('NOTIFICATION_NOT_FOUND', 'The notification was not found for this device', 404);
      if (notification.id !== notificationId) throw new Error('Invalid scoped inbox response');
      if (!await allowed(admin, deviceId)) fail('DESTINATION_NOT_ALLOWED', 'The destination is not allowed', 403);
      entry.attemptStarted = true;
      const result = await attemptBeep(admin, adminLimits, deviceId, notification, { attemptId });
      return receipt(deviceId, notification, false, result.status, result.persisted, true);
    });
    try { return await entry.promise; }
    catch (error) {
      // Limits, scoped reads and initial authorization can reject before the
      // marker/effect helper starts. Those failures must not trap a recoverable
      // request in the ten-minute cache. Uncertain effect outcomes stay cached.
      if (!entry.attemptStarted && retryAttempts.get(key) === entry) retryAttempts.delete(key);
      throw error;
    } finally { entry.completedAt = now(); entry.expiresAt = entry.completedAt + RETRY_TTL_MS; }
  };

  router.post('/api/notifications', async (req, res) => {
    try {
      const result = await send(req.notificationSender, req.body);
      return res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      const result = publicError(error);
      if (result.status === 429) res.set('Retry-After', '60');
      return res.status(result.status).json({ stored: result.stored, error: result.error });
    }
  });

  router.post('/mcp/notifications', async (req, res) => {
    // Explicitly require both MIME types, even though this server selects JSON.
    const accepted = (req.get('Accept') || '').split(',').map(part => part.trim().toLowerCase()).filter(part => !/;\s*q=0(?:\.0*)?(?:\s*;|$)/.test(part)).map(part => part.split(';')[0].trim());
    if (!accepted.includes('application/json') || !accepted.includes('text/event-stream')) {
      return rpcError(res, null, -32600, 'Accept must include application/json and text/event-stream', 406);
    }
    const body = req.body;
    const validId = id => typeof id === 'string' && id.length <= 128 || Number.isSafeInteger(id);
    if (!plainObject(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string' || body.method.length > 128 ||
        Object.hasOwn(body, 'id') && !validId(body.id) ||
        body.params !== undefined && !plainObject(body.params) ||
        Object.keys(body).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) {
      return rpcError(res, null, -32600, 'Expected one JSON-RPC 2.0 request or notification');
    }
    const hasId = Object.hasOwn(body, 'id');
    const headerVersion = req.get('MCP-Protocol-Version');
    if (headerVersion !== undefined && !PROTOCOL_VERSIONS.includes(headerVersion) ||
        body.method !== 'initialize' && !PROTOCOL_VERSIONS.includes(headerVersion)) {
      return rpcError(res, body.id, -32600, 'A supported MCP-Protocol-Version header is required after initialization');
    }
    if (!hasId) {
      // Never execute a tools/call disguised as a notification.
      if (body.method === 'notifications/initialized' || body.method === 'notifications/cancelled') return res.status(202).end();
      return rpcError(res, null, -32600, 'Unsupported client notification');
    }
    const result = value => res.json({ jsonrpc: '2.0', id: body.id, result: value });
    if (body.method === 'initialize') {
      const params = body.params;
      if (!plainObject(params) || typeof params.protocolVersion !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion) ||
          !plainObject(params.capabilities) || !plainObject(params.clientInfo) ||
          typeof params.clientInfo.name !== 'string' || !params.clientInfo.name || params.clientInfo.name.length > 128 ||
          typeof params.clientInfo.version !== 'string' || !params.clientInfo.version || params.clientInfo.version.length > 128) {
        return rpcError(res, body.id, -32602, 'initialize requires protocolVersion, capabilities and clientInfo');
      }
      return result({ protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'xiaozhi-notification-ingress', version: '1.0.0' } });
    }
    if (body.method === 'ping') return result({});
    if (body.method === 'tools/list') {
      if (body.params?.cursor !== undefined) return rpcError(res, body.id, -32602, 'This tool list has no continuation cursor');
      const sender = req.notificationSender;
      const tool = sender.defaultDeviceId ? { ...TOOL, inputSchema: { ...TOOL.inputSchema,
        required: ['text', 'idempotency_key'], properties: { ...TOOL.inputSchema.properties,
          device_id: { type: 'string', enum: [sender.defaultDeviceId] } } } } : TOOL;
      return result({ tools: [tool, ...additionalTools(sender)] });
    }
    if (body.method !== 'tools/call') return rpcError(res, body.id, -32601, 'Method not found');
    if (!plainObject(body.params) || typeof body.params.name !== 'string' ||
        body.params.arguments !== undefined && !plainObject(body.params.arguments)) {
      return rpcError(res, body.id, -32602, 'tools/call requires a tool name and object arguments');
    }
    if (body.params.name !== 'notify_send') {
      if (!callAdditionalTool || !additionalTools(req.notificationSender).some(tool => tool.name === body.params.name)) return rpcError(res, body.id, -32602, 'Unknown tool');
      try {
        const value = await withPermit(req.notificationSender, config, () => callAdditionalTool(req.notificationSender, body.params.name, body.params.arguments));
        return result({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
      } catch (error) {
        const value = { error: error.status ? error.message : error instanceof IngressError ? error.message : 'Agent registration could not be confirmed; check the dashboard before retrying' };
        return result({ content: [{ type: 'text', text: JSON.stringify(value) }], isError: true });
      }
    }
    try {
      const value = await send(req.notificationSender, body.params.arguments);
      return result({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false });
    } catch (error) {
      const safe = publicError(error);
      const value = { stored: safe.stored, error: safe.error };
      return result({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true });
    }
  });
  router.all(ROUTES, (req, res) => {
    res.set('Allow', 'POST');
    return res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Only POST is supported; no SSE stream is available' } });
  });
  router.use((error, req, res, next) => {
    if (!ROUTES.includes(req.path)) return next(error);
    const tooLarge = error?.type === 'entity.too.large';
    const status = tooLarge ? 413 : error?.status === 415 ? 415 : 400;
    if (req.path === '/mcp/notifications') return rpcError(res, null, -32700, tooLarge ? 'JSON body is too large' : 'Invalid JSON body', status);
    return res.status(status).json({ stored: false, error: { code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'INVALID_JSON', message: tooLarge ? 'JSON body is too large' : 'Invalid JSON body' } });
  });
  return router;
}

module.exports = { createNotificationIngress, publicError, LIMITS, PROTOCOL_VERSIONS, ADMIN_SENDER };
