require('dotenv').config();

// Force standard Gemini API instead of Vertex AI
delete process.env.GOOGLE_GENAI_USE_VERTEXAI;
delete process.env.GOOGLE_CLOUD_PROJECT;
delete process.env.GOOGLE_CLOUD_LOCATION;

const WebSocket = require('ws');
const prism = require('prism-media');
const http = require('http');
const crypto = require('crypto');
const { performance } = require('node:perf_hooks');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const chokidar = require('chokidar');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const bodyParser = require('body-parser');

// Providers
const GeminiProvider = require('./providers/gemini');
const QwenRealtimeProvider = require('./providers/qwen_realtime');
const QwenOmniProvider = require('./providers/qwen_omni');
const LlamaLiquidAudioServerProvider = require('./providers/llama-liquid-audio-server');
const LlamaLiquidInterleavedProvider = require('./providers/llama-liquid-interleaved');
const providersConfig = require('./providers/config');
const { MemoryStore, TurnBuffer } = require('./lib/memory');
const { fromEnvironment: notificationsFromEnvironment, validateRpcAdapter } = require('./lib/notifications');
const { mqttSettings, safeEqual, provisioningUuid, mqttClientId, credentialsFor, createGatewayRpc } = require('./lib/mqtt-integration');
const { createAudioService } = require('./lib/notification-audio');
const { parseTrustedProxies } = require('./lib/proxy-config');
const { parseDeviceTimezoneOffset, deviceServerTime } = require('./lib/device-time');
const { NotificationInbox } = require('./lib/inbox');
const { createNotificationIngress, publicError: notificationPublicError } = require('./lib/notification-ingress');
const { INBOX_TOOLS, INBOX_INSTRUCTION, canUseInboxTools, isInboxToolCall, createInboxTools } = require('./lib/inbox-tools');
const { createReminderService, mountReminderRoutes } = require('./lib/reminders');
const { REMINDER_TOOLS, REMINDER_INSTRUCTION, REMINDER_TOOL_NAMES, createReminderTools } = require('./lib/reminder-tools');
const { createEdgeTts } = require('./lib/edge-tts');
const { createScreenBreakService } = require('./lib/screen-breaks');
const { createInboxAnnouncement } = require('./lib/inbox-announcement');
const { createNotificationReminders } = require('./lib/notification-reminders');
const { RemoteMcpServers, REMOTE_MCP_INSTRUCTION } = require('./lib/remote-mcp');
const { AgentConnections } = require('./lib/agent-connections');
const { McpEndpoint, MAX_PAYLOAD: MCP_ENDPOINT_MAX_PAYLOAD } = require('./lib/mcp-endpoint');
const { VoiceIdleTimer, validateVoiceIdleSeconds, parseVoiceIdleSeconds, resolveVoiceIdleSeconds, parseVoiceActivityThreshold } = require('./lib/voice-idle');
const { sanitizeLogValue, formatLogEntry, createSessionTrace } = require('./lib/session-trace');
const { startSocketHeartbeat } = require('./lib/socket-heartbeat');
const { LiveRecovery } = require('./lib/live-recovery');
const { PacedAudioInput } = require('./lib/paced-audio-input');

// Configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const LLM_BACKEND = process.env.LLM_BACKEND || 'gemini'; // 'gemini' or 'qwen'
const CLIENT_AUTH_TOKEN = process.env.CLIENT_AUTH_TOKEN || 'default_token';
const PORT = Number(process.env.PORT || 3000);
const DEVICE_TIMEZONE_OFFSET_MINUTES = parseDeviceTimezoneOffset(process.env.DEVICE_TIMEZONE_OFFSET_MINUTES);
const VOICE_IDLE_TIMEOUT_SECONDS = parseVoiceIdleSeconds(process.env.VOICE_IDLE_TIMEOUT_SECONDS);
const VOICE_ACTIVITY_THRESHOLD = parseVoiceActivityThreshold(process.env.VOICE_ACTIVITY_THRESHOLD);
const HOST = process.env.HOST || '0.0.0.0';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-native-audio-preview-12-2025';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3-omni-flash-realtime';
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Aoede';
const QWEN_VOICE = process.env.QWEN_VOICE || 'Cherry';
const MQTT_ENDPOINT = process.env.MQTT_ENDPOINT || 'mqtt://localhost:1883';
const WEBSOCKET_URL_FOR_ALLOWED_DEVICE = process.env.WEBSOCKET_URL_FOR_ALLOWED_DEVICE || `ws://localhost:${PORT}/xiaozhi/v1/`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
const ADMIN_PASSWORD_READY = Boolean(process.env.ADMIN_PASSWORD && ADMIN_PASSWORD.length >= 12 && ADMIN_PASSWORD.length <= 512 && !/your_|change.?me|replace.?me|placeholder|example/i.test(ADMIN_PASSWORD));
const INVALID_TEST_TOKEN = process.env.INVALID_TEST_TOKEN || 'invalid_token';

// Paths
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const BUILTIN_MCP_ID = 'parrot-dashboard';
const RESTART_FILE_PATH = path.join(__dirname, 'tmp', 'restart.txt');
const DEVICES_FILE_PATH = path.join(DATA_DIR, 'devices.json');
const MCP_DEVICES_FILE_PATH = path.join(DATA_DIR, 'mcp_devices.json');

// Configure Winston Logger
const logSecrets = Object.entries(process.env).filter(([name]) => /(?:KEY|TOKEN|PASSWORD|SECRET|SIGNATURE)/i.test(name)).map(([, value]) => value);
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(info => formatLogEntry(info, logSecrets))
  ),
  transports: [
    new winston.transports.Console(),
    new DailyRotateFile({
      filename: path.join(DATA_DIR, 'connection-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      dirname: DATA_DIR,
    })
  ],
});

process.on('unhandledRejection', reason => {
  logger.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught Exception:', error);
  // Give logger time to flush before exiting
  setTimeout(() => process.exit(1), 1000);
});

// Watcher for restart.txt
const watcher = chokidar.watch(RESTART_FILE_PATH, {
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 }
});

watcher.on('add', (path) => { logger.info(`Restart file detected: ${path}. Shutting down.`); process.exit(0); });
watcher.on('change', (path) => { logger.info(`Restart file modified: ${path}. Shutting down.`); process.exit(0); });

// Device Management
let devices = {};
let mcpDevices = {};
const activeVoiceSockets = new Map();
const voiceTeardowns = new Map();
function hasDedicatedDeviceToken(id) {
  const token = devices[id]?.token;
  return typeof token === 'string' && token.length > 0 && token !== CLIENT_AUTH_TOKEN &&
    !Object.entries(devices).some(([other, device]) => other !== id && device.token === token);
}
function mutationContext(req, operation, changes = {}) {
  return { source: 'dashboard_api', request_id: crypto.randomUUID(), operation,
    method: req.method, route: req.route.path, peer: req.socket.remoteAddress, ...changes };
}
function closeDeviceSessions(id, reason = 'device_settings_changed', context = {}) {
  logger.info('Device session close requested:', { device_id: id, reason,
    active_voice_count: activeVoiceSockets.get(id)?.size || 0, ...context });
  for (const ws of activeVoiceSockets.get(id) || []) {
    voiceTraces.get(ws)?.event('session.close_requested', { reason, ...context });
    voiceTeardowns.get(ws)?.(reason);
    ws.close(1000, reason);
  }
}
function reportMcpChange(deviceId, connectionId, event, details = {}) {
  const fields = { source: 'mcp_lifecycle', connection_id: connectionId,
    effect: details.cause === 'revoked' ? 'voice_invalidation' : 'tools_apply_next_session', ...details };
  logger.info('MCP lifecycle change:', { event, device_id: deviceId, ...fields });
  for (const ws of activeVoiceSockets.get(deviceId) || []) voiceTraces.get(ws)?.event(event, fields);
}

try {
  if (fs.existsSync(DEVICES_FILE_PATH)) {
    devices = JSON.parse(fs.readFileSync(DEVICES_FILE_PATH, 'utf8'));
    let modified = false;
    for (const mac in devices) {
      if (!devices[mac].enabled_mcp_devices) devices[mac].enabled_mcp_devices = [];
      if (!devices[mac].enabled_mcp_devices.includes(BUILTIN_MCP_ID)) {
        devices[mac].enabled_mcp_devices.push(BUILTIN_MCP_ID);
        modified = true;
      }
    }
    if (modified) saveDevices();
  } else {
    fs.writeFileSync(DEVICES_FILE_PATH, JSON.stringify({}));
  }
} catch (e) {
  logger.error(`Failed to load devices.json: ${e.message}`);
}

try {
  if (fs.existsSync(MCP_DEVICES_FILE_PATH)) {
    mcpDevices = JSON.parse(fs.readFileSync(MCP_DEVICES_FILE_PATH, 'utf8'));
  } else {
    fs.writeFileSync(MCP_DEVICES_FILE_PATH, JSON.stringify({}));
  }
} catch (e) {
  logger.error(`Failed to load mcp_devices.json: ${e.message}`);
}

function saveDevices() {
  fs.writeFileSync(DEVICES_FILE_PATH, JSON.stringify(devices, null, 2));
}

function saveMcpDevices() {
  fs.writeFileSync(MCP_DEVICES_FILE_PATH, JSON.stringify(mcpDevices, null, 2));
}

let remoteMcp = null;
try {
  remoteMcp = new RemoteMcpServers({
    filename:path.join(DATA_DIR,'remote-mcp-servers.json'),
    allowHttp:process.env.MCP_ALLOW_HTTP === 'true',
    onError:()=>logger.warn('Remote MCP connection unavailable; check its dashboard status.')
  });
  remoteMcp.start();
} catch { logger.error('Remote MCP configuration unavailable; existing voice and notifications remain available.'); }

let agentConnections = null;
let endpointMcp = null;
try {
  agentConnections = new AgentConnections({
    filename: path.join(DATA_DIR, 'agent-connections.json'), remoteMcp,
    endpointStatus: id => endpointMcp?.status(id),
    onRevoked: id => endpointMcp?.revoke(id),
    resolveDevice: id => Object.hasOwn(devices, id) && hasDedicatedDeviceToken(id) &&
      (devices[id].llm_backend || LLM_BACKEND) === 'gemini' ? devices[id] : null,
    toolsEnabled: (id, serverId) => devices[id]?.status === 'approved' && hasDedicatedDeviceToken(id) &&
      (devices[id].llm_backend || LLM_BACKEND) === 'gemini' && devices[id].enabled_mcp_devices?.includes(serverId),
    onRegistered: (deviceId, serverId) => {
      const device = devices[deviceId];
      const previousSelection = device.enabled_mcp_devices;
      const selectionChanged = !previousSelection?.includes(serverId);
      if (selectionChanged) {
        device.enabled_mcp_devices = [...new Set([...(previousSelection || []), serverId])];
        try { saveDevices(); }
        catch (error) { device.enabled_mcp_devices = previousSelection; throw error; }
      }
      // Discovery/reconnect is background activity. Retain the current voice
      // provider and its tool snapshot; newly discovered tools load next time.
      reportMcpChange(deviceId, serverId, 'mcp.tools_available', { selection_changed: selectionChanged });
    }
  });
} catch { logger.error('Dashboard agent setup unavailable; check the private agent configuration file.'); }

const builtinTools = [
  {
    name: "server.get_pending_devices",
    description: "Get a list of Xiaozhi or MCP devices that are waiting for approval on this server.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "server.approve_device",
    description: "Approve a pending Xiaozhi or MCP device by its ID so it can be used.",
    parameters: { 
      type: "object", 
      properties: { 
        id: { type: "string", description: "The ID of the device to approve." },
        type: { type: "string", enum: ["xiaozhi", "mcp"], description: "The type of device." }
      }, 
      required: ["id", "type"],
      additionalProperties: false 
    }
  },
  {
    name: "server.update_config",
    description: "Update the AI configuration (backend, model, voice, system prompt) for the currently connected device. Note: Changes take effect on the next session connection.",
    parameters: {
      type: "object",
      properties: {
        llm_backend: { type: "string", enum: providersConfig.map(p => p.id), description: "The AI backend to use." },
        gemini_model: { type: "string", enum: (providersConfig.find(p => p.id === 'gemini')?.models.map(m => m.id) || []), description: "Valid Gemini models." },
        qwen_model: { type: "string", enum: [...new Set([...(providersConfig.find(p => p.id === 'qwen_realtime')?.models.map(m => m.id) || []), ...(providersConfig.find(p => p.id === 'qwen_omni')?.models.map(m => m.id) || [])])], description: "Valid Qwen models." },
        gemini_voice: { type: "string", enum: (providersConfig.find(p => p.id === 'gemini')?.voices || []), description: "Valid Gemini voices." },
        qwen_voice: { type: "string", enum: [...new Set([...(providersConfig.find(p => p.id === 'qwen_realtime')?.voices || []), ...(providersConfig.find(p => p.id === 'qwen_omni')?.voices || [])])], description: "Valid Qwen voices." },
        llama_model: { type: "string", enum: [...new Set([...(providersConfig.find(p => p.id === 'llama_liquid_audio_server')?.models.map(m => m.id) || []), ...(providersConfig.find(p => p.id === 'llama_liquid_interleaved')?.models.map(m => m.id) || [])])], description: "Valid Llama models." },
        llama_voice: { type: "string", enum: [...new Set([...(providersConfig.find(p => p.id === 'llama_liquid_audio_server')?.voices || []), ...(providersConfig.find(p => p.id === 'llama_liquid_interleaved')?.voices || [])])], description: "Valid Llama voices." },
        prompt: { type: "string", description: "The system prompt for the AI." }
      },
      additionalProperties: false
    }
  }
];

// MCP Server State
const mcpClients = new Map(); // ws -> { id: string, tools: array }
let mcpMessageId = 1;
const mcpCallbacks = new Map(); // id -> resolve function
const voiceTraces = new WeakMap();

function sendMcpRequest(ws, method, params) {
  return new Promise((resolve, reject) => {
    const info = mcpClients.get(ws);
    const id = mcpMessageId++;
    const trace = voiceTraces.get(ws);
    const started = performance.now();
    let timeout;
    mcpCallbacks.set(id, response => {
      clearTimeout(timeout);
      trace?.event('mcp.rpc_response', { rpc_id: id, method, duration_ms: Math.round(performance.now() - started),
        failed: Boolean(response.error), error: response.error,
        tool_count: response.result?.tools?.length }, response.error ? 'warn' : 'info');
      resolve(response);
    });

    let requestPayload = { jsonrpc: "2.0", id, method, params };
    if (info && info.isXiaozhi) {
      requestPayload = { type: 'mcp', payload: requestPayload };
    }

    logger.debug(`[MCP] Sending ${method} to ${info?.id || 'unknown'}`);
    trace?.event('mcp.rpc_request', { rpc_id: id, method, tool: method === 'tools/call' ? params.name : undefined });
    try { ws.send(JSON.stringify(requestPayload)); }
    catch (error) {
      mcpCallbacks.delete(id);
      trace?.event('mcp.rpc_send_error', { rpc_id: id, method, error }, 'error');
      reject(error);
      return;
    }

    const timeoutMs = method === 'tools/call' ? 5000 : 30000;
    timeout = setTimeout(() => {
      if (mcpCallbacks.has(id)) {
        mcpCallbacks.delete(id);
        trace?.event('mcp.rpc_timeout', { rpc_id: id, method, duration_ms: Math.round(performance.now() - started),
          outcome: method === 'tools/call' ? 'dispatched_without_confirmation' : 'failed' }, 'warn');
        if (method === 'tools/call') {
          logger.warn(`[MCP] Timeout for ${method} on ${info?.id || 'unknown'}, assuming success.`);
          resolve({ result: { success: true, note: "Action dispatched, but no confirmation received (timeout)." } });
        } else {
          reject(new Error(`Timeout waiting for MCP response after ${timeoutMs/1000}s`));
        }
      }
    }, timeoutMs);
  });
}

function setupMcpClient(ws, clientId, isXiaozhi = false) {
  if (mcpClients.has(ws)) return Promise.resolve();

  mcpClients.set(ws, { id: clientId, tools: [], isXiaozhi });
  logger.info(`[MCP] Registering ${isXiaozhi ? 'Xiaozhi' : 'External'} device: ${clientId}`);

  // Register in mcp_devices if new
  if (!mcpDevices[clientId]) {
    mcpDevices[clientId] = { status: 'pending', name: clientId };
    saveMcpDevices();
  }

  // Initialize MCP Connection
  logger.debug(`[MCP] Sending initialize to ${clientId}`);
  return sendMcpRequest(ws, 'initialize', {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "ParrotServer", version: "1.0.0" }
  }).then(() => {
    // MCP Protocol requires sending an initialized notification before making further requests
    let initNotification = {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    };
    if (isXiaozhi) initNotification = { type: 'mcp', payload: initNotification };
    ws.send(JSON.stringify(initNotification));

    logger.info(`[MCP] Device ${clientId} initialized. Requesting tools...`);
    return sendMcpRequest(ws, 'tools/list', {});
  }).then((res) => {
    const info = mcpClients.get(ws);
    if (info && res.result && res.result.tools) {
      info.tools = res.result.tools;
      logger.info(`[MCP] Device ${clientId} registered ${res.result.tools.length} tools.`);
    }
    return info;
  }).catch(e => {
    logger.error(`[MCP] Error initializing client ${clientId}: ${e.message}`);
    throw e;
  });
}

const app = express();
app.set('trust proxy', parseTrustedProxies(process.env.TRUST_PROXY));

// Admin Authentication Middleware
function requireAuth(req, res, next) {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// Optional memory and notification features are isolated from the realtime audio path.
function boundedMemorySetting(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < min || value > max) {
    logger.warn(`${name} is invalid; using conservative default ${fallback}.`);
    return fallback;
  }
  return value;
}
const memoryStore = new MemoryStore({
  databasePath: path.join(DATA_DIR, 'memory.sqlite'),
  maxFacts: 20,
  maxContextChars: boundedMemorySetting('MEMORY_CONTEXT_MAX_CHARS', 6000, 256, 24000),
  maxRecentTurns: boundedMemorySetting('MEMORY_MAX_TURNS', 8, 1, 24),
  maxTurnChars: boundedMemorySetting('MEMORY_TURN_MAX_CHARS', 1200, 100, 2000)
});
const mqttConfig = mqttSettings(process.env);
let notifications;
try {
  let notificationRpc;
  if (process.env.NOTIFY_ENABLED === 'true' && process.env.NOTIFY_ADAPTER_MODULE) {
    // Operator-controlled local module only, never a request parameter.
    notificationRpc = validateRpcAdapter(require(path.resolve(process.env.NOTIFY_ADAPTER_MODULE)));
  } else if (mqttConfig.configured) {
    notificationRpc = createGatewayRpc(mqttConfig);
  }
  const builtinGateway = !process.env.NOTIFY_ADAPTER_MODULE && mqttConfig.configured;
  notifications = notificationsFromEnvironment(process.env, {
    rpc: notificationRpc,
    transport: builtinGateway ? 'bundled-mqtt-gateway-http' : 'custom-gateway-adapter',
    resolveDevice: (id) => Object.hasOwn(devices, id) ? devices[id] : null,
    ...(builtinGateway ? {resolveClientId: (id, device) => device?.transport === 'mqtt' && hasDedicatedDeviceToken(id) ? device.mqtt_client_id : null} : {})
  });
} catch {
  // A broken optional gateway must not interrupt the existing voice server.
  logger.error('Notification configuration invalid; notifications disabled.');
  notifications = notificationsFromEnvironment({});
}
const notificationAudio = createAudioService({
  directory: process.env.NOTIFY_AUDIO_DIR || path.join(__dirname, 'notification-audio'),
  publicBaseUrl: process.env.NOTIFY_AUDIO_BASE_URL || '',
  signingKey: mqttConfig.serviceKey || '',
  allowHttp: process.env.NOTIFY_ALLOW_HTTP === 'true'
});
const notificationInbox = new NotificationInbox({databasePath:path.join(DATA_DIR,'notifications.sqlite'),retentionDays:30,maxPerDevice:100});
const inboxToolMaxChars = boundedMemorySetting('INBOX_TOOL_MAX_CHARS',4000,512,6000);
const reminderIntervalMs = boundedMemorySetting('NOTIFY_REMINDER_INTERVAL_MS',60000,0,86400000);
function canSendReminder(deviceId) {
  const status = notifications.status();
  return status.enabled && status.configured && devices[deviceId]?.status === 'approved' &&
    devices[deviceId]?.transport === 'mqtt' && hasDedicatedDeviceToken(deviceId) &&
    !activeVoiceSockets.get(deviceId)?.size;
}
async function sendInboxBeep(deviceId, notification, attempt = {}) {
  try {
    if (!canSendReminder(deviceId)) return {status:'not_published',reason:'device_offline_or_busy',playback:'unknown'};
    const eligibility = await notificationInbox.reminders(deviceId, 'can_beep', { notification_id: notification.id }, DEVICE_TIMEZONE_OFFSET_MINUTES);
    if (!eligibility.allowed) return {status:'not_published',reason:eligibility.reason,playback:'unknown'};
    const asset = await notificationAudio.issue(process.env.NOTIFY_BEEP_ASSET || 'sample-chime.ogg');
    // Only an explicit admin retry may beep an already-read message.
    // Automatic repeats still stop on read; quiet hours and reminder state apply to both.
    const manualRetry = typeof attempt.attemptId === 'string' && !attempt.reminder;
    // Approval, read state or session activity may change while issuing a URL.
    const current = await notificationInbox.get(deviceId, notification.id);
    if (!current || (!manualRetry && current.readAt !== null) || !canSendReminder(deviceId)) {
      return {status:'not_published',reason:'reminder_cancelled',playback:'unknown'};
    }
    const recheck = await notificationInbox.reminders(deviceId, 'can_beep', { notification_id: notification.id }, DEVICE_TIMEZONE_OFFSET_MINUTES);
    if (!recheck.allowed) return {status:'not_published',reason:recheck.reason,playback:'unknown'};
    if (attempt.reminder) {
      const claim = await notificationInbox.reminders(deviceId, 'claim_beep', { notification_id: notification.id,
        interval_ms: Math.max(1000, reminderIntervalMs) }, DEVICE_TIMEZONE_OFFSET_MINUTES);
      if (!claim.allowed) return {status:'not_published',reason:claim.reason,playback:'unknown'};
    }
    // Each deliberate reminder has a fresh key; no notification text enters audio.
    const idempotencyKey = attempt.attemptId ? `inbox-retry-${notification.id}-${crypto.createHash('sha256').update(attempt.attemptId).digest('hex').slice(0,32)}` : `inbox-${notification.id}`;
    return await notifications.send(deviceId,{audio_url:asset.audio_url,idempotencyKey});
  } catch { return {status:'not_published',reason:'beep_unavailable',playback:'unknown'}; }
}
const reminderService = createReminderService({ inbox: notificationInbox, defaultOffset: DEVICE_TIMEZONE_OFFSET_MINUTES,
  deviceIds: () => Object.keys(devices),
  allowed: id => devices[id]?.status === 'approved' && hasDedicatedDeviceToken(id),
  beep: sendInboxBeep,
  onEvent: (event, fields) => logger.info('Reminder lifecycle:', { event, ...fields })
});
const screenTts = createEdgeTts({ directory: path.join(DATA_DIR, 'announcement-audio'), publicBaseUrl: process.env.NOTIFY_AUDIO_BASE_URL || '',
  signingKey: mqttConfig.serviceKey || '', allowHttp: process.env.NOTIFY_ALLOW_HTTP === 'true' });
async function screenDeviceOnline(id) {
  if (!canSendReminder(id) || !mqttConfig.configured || process.env.NOTIFY_ADAPTER_MODULE) return false;
  try {
    const response = await fetch(`${mqttConfig.gatewayUrl}/online?clientId=${encodeURIComponent(devices[id].mqtt_client_id)}`,
      { headers: { Authorization: `Bearer ${mqttConfig.serviceKey}` }, signal: AbortSignal.timeout(3000), redirect: 'error' });
    return response.ok && (await response.json()).online === true;
  } catch { return false; }
}
const screenBreaks = createScreenBreakService({ reminders: reminderService, deviceIds: () => Object.keys(devices),
  allowed: id => devices[id]?.status === 'approved' && hasDedicatedDeviceToken(id),
  busy: id => Boolean(activeVoiceSockets.get(id)?.size), online: screenDeviceOnline, tts: screenTts,
  send: (id, payload) => canSendReminder(id) ? notifications.send(id, payload) : { status: 'not_published', reason: 'device_busy' },
  onEvent: (event, fields) => logger.info('Screen break lifecycle:', { event, ...fields }) });
const notificationIngress = createNotificationIngress({
  env:process.env,
  inbox:notificationInbox,
  resolveDevice:id=>Object.hasOwn(devices,id) && hasDedicatedDeviceToken(id) ? devices[id] : null,
  beep:sendInboxBeep,
  additionalSenders: () => agentConnections?.senders() || [],
  additionalTools: sender => agentConnections?.tools(sender) || [],
  callAdditionalTool: (sender, name, args) => agentConnections.register(sender, args)
});
if (agentConnections) endpointMcp = new McpEndpoint({
  connections: agentConnections,
  isDeviceAllowed: id => Object.hasOwn(devices, id) && devices[id].status === 'approved' &&
    hasDedicatedDeviceToken(id) && (devices[id].llm_backend || LLM_BACKEND) === 'gemini',
  onReady: (deviceId, connectionId) => agentConnections.onRegistered(deviceId, connectionId),
  onChanged: (deviceId, connectionId, details) => {
    reportMcpChange(deviceId, connectionId, 'mcp.endpoint_disconnected', details);
    // Explicit credential revocation still invalidates the active conversation.
    if (details?.cause === 'revoked') closeDeviceSessions(deviceId, 'agent_connection_revoked',
      { source: 'mcp_revocation', connection_id: connectionId });
  },
  publish: (sender, args) => notificationIngress.publishSender(sender, args),
  publicError: notificationPublicError
});
const notificationReminders = createNotificationReminders({
  inbox:notificationInbox,
  deviceIds:()=>Object.keys(devices),
  canSend:canSendReminder,
  beep:sendInboxBeep,
  intervalMs:reminderIntervalMs,
  onError:()=>logger.warn('Notification reminder attempt failed; will check again later.')
});
notificationReminders.start();
reminderService.start();
screenBreaks.start();
app.use(notificationIngress);
app.use(bodyParser.json({ limit: '32kb' }));
app.use(session({
  store: new FileStore({ path: path.join(DATA_DIR, 'sessions'), logFn: () => {} }),
  secret: crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Serve static files for web UI
app.use(express.static(path.join(__dirname, 'public')));


const cleanupMemory = async () => {
  await memoryStore.cleanup().catch(()=>logger.warn('Memory retention cleanup failed.'));
  await notificationInbox.cleanup().catch(()=>logger.warn('Notification inbox retention cleanup failed.'));
};
cleanupMemory();
const retentionTimer = setInterval(cleanupMemory, 60 * 60 * 1000);
retentionTimer.unref();

// These endpoints belong to the single authenticated server administrator.
// JSON + custom header and no CORS permit same-origin dashboard writes only.
function featureDevice(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (!ADMIN_PASSWORD_READY) {
    return res.status(503).json({ error: 'Set a unique ADMIN_PASSWORD of at least 12 characters before using memory or notifications' });
  }
  if (!Object.hasOwn(devices, req.params.mac) || devices[req.params.mac].status !== 'approved') {
    return res.status(404).json({ error: 'Approved device not found' });
  }
  if (req.path.endsWith('/memory') && req.method === 'PUT' && req.body?.enabled === true && !hasDedicatedDeviceToken(req.params.mac)) {
    return res.status(409).json({ error: 'Device memory requires a dedicated per-device token; provision it before enabling memory' });
  }
  if (req.method !== 'GET' && (!req.is('application/json') || req.get('X-Requested-With') !== 'XiaozhiDashboard')) {
    return res.status(403).json({ error: 'Same-origin JSON dashboard request required' });
  }
  next();
}
// Private service-to-service registry: never exposes credentials to dashboard callers.
app.get('/internal/mqtt/devices/:mac', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!mqttConfig.configured || !safeEqual(req.get('Authorization'), `Bearer ${mqttConfig.serviceKey}`)) {
    return res.status(401).json({error:'Unauthorized'});
  }
  const id = Object.keys(devices).find(key => key.toLowerCase() === req.params.mac.toLowerCase());
  const device = id && devices[id];
  if (!device || device.status !== 'approved' || device.transport !== 'mqtt' ||
      !hasDedicatedDeviceToken(id) || typeof req.query.client_id !== 'string' ||
      device.mqtt_client_id !== req.query.client_id || device.mqtt_client_id !== mqttClientId(id, device)) {
    return res.status(404).json({error:'Approved MQTT device not found'});
  }
  res.json({device_id:id, client_id:device.mqtt_client_id, token:device.token});
});
app.get('/api/mqtt/status', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({enabled:mqttConfig.enabled,configured:mqttConfig.configured,reason:mqttConfig.reason,
    notifyAllowHttp:process.env.NOTIFY_ALLOW_HTTP==='true',audioConfigured:notificationAudio.configured,
    notifications:notifications.status(),inbox:notificationIngress.status(),reminderIntervalMs,transport:'bundled-mqtt-gateway-http'});
});
app.post('/api/devices/:mac/transport', requireAuth, featureDevice, (req, res) => {
  if (!req.body || Object.keys(req.body).some(key => key !== 'transport') || !['mqtt','websocket'].includes(req.body.transport)) {
    return res.status(400).json({error:'Choose transport mqtt or websocket'});
  }
  const id=req.params.mac, device=devices[id];
  if(req.body.transport==='mqtt') {
    if(!mqttConfig.configured) return res.status(503).json({error:mqttConfig.reason || 'MQTT is not configured'});
    const clientId=mqttClientId(id,device);
    if(!hasDedicatedDeviceToken(id) || !clientId) return res.status(409).json({error:'MQTT needs a dedicated device token and known device UUID. Reconnect this device over its working WebSocket connection first.'});
    device.mqtt_client_id=clientId;
  }
  device.transport=req.body.transport;
  saveDevices();
  closeDeviceSessions(id, 'transport_changed', mutationContext(req, 'transport_save', { transport: device.transport }));
  res.json({success:true,transport:device.transport,reconnect_required:true});
});
function audioAdmin(req,res,next) {
  res.set('Cache-Control','no-store');
  if(!ADMIN_PASSWORD_READY) return res.status(503).json({error:'Configure a unique admin password of at least 12 characters'});
  if(req.method!=='GET' && (!req.is('application/json') || req.get('X-Requested-With')!=='XiaozhiDashboard')) return res.status(403).json({error:'Same-origin JSON dashboard request required'});
  next();
}
app.get('/api/notification-audio',requireAuth,audioAdmin,async(req,res)=>{
  try {res.json({configured:notificationAudio.configured,reason:notificationAudio.reason,files:await notificationAudio.list()});}
  catch {res.status(503).json({error:'Notification audio unavailable'});}
});
app.post('/api/notification-audio/url',requireAuth,audioAdmin,async(req,res)=>{
  if(!req.body || Object.keys(req.body).some(key=>key!=='name') || typeof req.body.name!=='string') return res.status(400).json({error:'Choose an audio filename'});
  try {res.json(await notificationAudio.issue(req.body.name));}
  catch(error){res.status(error.statusCode||503).json({error:error.message});}
});
for (const [audioPath, audioService] of [['/notification-audio/:name', notificationAudio], ['/announcement-audio/:name', screenTts]]) app.get(audioPath,async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  res.set('X-Content-Type-Options','nosniff');
  try {
    const asset=await audioService.open({name:req.params.name,expires:req.query.expires,signature:req.query.signature});
    res.set('Content-Type',asset.contentType);res.set('Content-Length',String(asset.size));
    asset.stream.on('error',()=>res.destroy());
    res.on('close',()=>asset.stream.destroy());
    asset.stream.pipe(res);
  } catch(error){res.status(error.statusCode||404).json({error:'Audio unavailable or link expired'});}
});

function memoryView(snapshot) {
  return { enabled: snapshot.enabled, facts: snapshot.facts, turns: snapshot.recentTurns, retentionDays: 30, contextMaxChars: memoryStore.maxContextChars, maxRecentTurns: memoryStore.maxRecentTurns };
}
app.post('/api/devices/:mac/inbox', requireAuth, featureDevice, async(req,res)=>{
  if(!req.body || typeof req.body!=='object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key=>!['title','text','idempotency_key'].includes(key))) {
    return res.status(400).json({stored:false,error:{code:'INVALID_INPUT',message:'Provide title, text and idempotency_key only'}});
  }
  try {
    const result=await notificationIngress.publishAdmin({device_id:req.params.mac,...req.body});
    res.status(result.duplicate?200:201).json(result);
  } catch(error) {
    const result=notificationPublicError(error);
    if(result.status===429)res.set('Retry-After','60');
    res.status(result.status).json({stored:result.stored,error:result.error});
  }
});
app.post('/api/devices/:mac/inbox/:id/beep', requireAuth, featureDevice, async(req,res)=>{
  if(!req.body || typeof req.body!=='object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key=>!['confirm','attempt_id'].includes(key)) ||
      typeof req.body.attempt_id!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.body.attempt_id)) {
    return res.status(400).json({stored:null,error:{code:'INVALID_INPUT',message:'Explicit confirmation and a UUID attempt_id are required'}});
  }
  try {
    res.json(await notificationIngress.retryAdminBeep(req.params.mac,req.params.id,{confirm:req.body.confirm,attemptId:req.body.attempt_id}));
  } catch(error) {
    const result=notificationPublicError(error);
    if(result.status===429)res.set('Retry-After','60');
    // This operation never creates or deletes a message; failure is about retrying its beep.
    res.status(result.status).json({stored:null,error:result.error});
  }
});
app.get('/api/devices/:mac/inbox', requireAuth, featureDevice, async(req,res)=>{
  try {res.json(await notificationInbox.list(req.params.mac,{unreadOnly:req.query.unread_only!=='false',limit:5,...(typeof req.query.cursor==='string'?{cursor:req.query.cursor}:{})}));}
  catch {res.status(503).json({error:'Notification inbox unavailable'});}
});
app.get('/api/devices/:mac/inbox/:id', requireAuth, featureDevice, async(req,res)=>{
  try {const item=await notificationInbox.get(req.params.mac,req.params.id);if(!item)return res.status(404).json({error:'Notification not found'});res.json(item);}
  catch {res.status(503).json({error:'Notification inbox unavailable'});}
});
app.post('/api/devices/:mac/inbox/:id/read', requireAuth, featureDevice, async(req,res)=>{
  if(req.body?.confirm!==true)return res.status(400).json({error:'Explicit confirmation required'});
  try {const item=await notificationInbox.markRead(req.params.mac,req.params.id);if(!item)return res.status(404).json({error:'Notification not found'});res.json(item);}
  catch {res.status(503).json({error:'Notification inbox unavailable'});}
});
mountReminderRoutes(app, { requireAuth, featureDevice, service: reminderService });
app.get('/api/devices/:mac/memory', requireAuth, featureDevice, async (req, res) => {
  try { res.json(memoryView(await memoryStore.get(req.params.mac))); }
  catch { res.status(503).json({ error: 'Memory storage unavailable' }); }
});
app.put('/api/devices/:mac/memory', requireAuth, featureDevice, async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key => !['enabled', 'facts'].includes(key)) ||
      typeof req.body.enabled !== 'boolean' || !Array.isArray(req.body.facts)) {
    return res.status(400).json({ error: 'Provide enabled (boolean) and facts (array)' });
  }
  try {
    const snapshot = await memoryStore.configure(req.params.mac, { enabled: req.body.enabled, facts: req.body.facts });
    if (!snapshot.enabled) closeDeviceSessions(req.params.mac, 'memory_disabled', mutationContext(req, 'memory_disable'));
    res.json(memoryView(snapshot));
  }
  catch (error) { res.status(error instanceof TypeError || error instanceof RangeError ? 400 : 503).json({ error: 'Invalid memory settings or storage unavailable' }); }
});
app.delete('/api/devices/:mac/memory', requireAuth, featureDevice, async (req, res) => {
  if (!req.body || req.body.confirm !== req.params.mac) return res.status(400).json({ error: 'Confirm the exact device ID' });
  try {
    const snapshot = await memoryStore.clear(req.params.mac);
    closeDeviceSessions(req.params.mac, 'memory_cleared', mutationContext(req, 'memory_clear'));
    res.json(memoryView(snapshot));
  }
  catch { res.status(503).json({ error: 'Memory storage unavailable' }); }
});
app.post('/api/devices/:mac/notifications', requireAuth, featureDevice, async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
      Object.keys(req.body).some(key => !['audio_url', 'subtitles', 'idempotency_key', 'expires_at'].includes(key))) {
    return res.status(400).json({ error: 'Unexpected notification fields' });
  }
  try {
    const result = await notifications.send(req.params.mac, {
      audio_url: req.body.audio_url, subtitles: req.body.subtitles,
      idempotencyKey: req.body.idempotency_key, expiresAt: req.body.expires_at
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 503).json({ error: error.code || 'Notification unavailable', message: error.message });
  }
});

// Web UI API Routes
app.post('/api/login', (req, res) => {
  if(!ADMIN_PASSWORD_READY) return res.status(503).json({error:'Configure a unique ADMIN_PASSWORD of at least 12 characters; example placeholders cannot log in'});
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.authenticated = true;
    req.session.save((err) => {
      res.json({ success: true });
    });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy((err) => {
    res.json({ success: true });
  });
});

app.get('/api/auth/status', requireAuth, (req, res) => {
  res.json({ authenticated: true });
});

app.get('/api/providers', requireAuth, (req, res) => {
  const providersWithStatus = providersConfig.map(p => {
      const configured = p.envVars ? p.envVars.every(envVar => !!process.env[envVar]) : true;
      return { ...p, configured };
  });
  res.json({ default_backend: LLM_BACKEND, providers: providersWithStatus, voice_idle_timeout_seconds: VOICE_IDLE_TIMEOUT_SECONDS });
});

app.get('/api/devices', requireAuth, (req, res) => {
  res.json(devices);
});

app.post('/api/devices/:mac/approve', requireAuth, (req, res) => {
  const mac = req.params.mac;
  if (devices[mac]) {
    if (devices[mac].purge_pending) return res.status(409).json({error:'Finish device deletion before approving it again'});
    devices[mac].status = 'approved';
    saveDevices();
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

app.delete('/api/devices/:mac', requireAuth, async (req, res) => {
  const mac=req.params.mac;
  if(!Object.hasOwn(devices,mac))return res.status(404).json({error:'Device not found'});
  // Revoke first. If erasure fails, retain this retryable tombstone rather than
  // allowing new publisher writes or accidentally restoring approval.
  const previous=devices[mac];
  const revoked={...previous,status:'revoked',purge_pending:true};
  devices[mac]=revoked;
  try {saveDevices();}
  catch {devices[mac]=previous;return res.status(503).json({error:'Could not revoke device'});}
  closeDeviceSessions(mac, 'device_revoked', mutationContext(req, 'device_delete'));
  try {
    await Promise.all([memoryStore.configure(mac,{enabled:false,facts:[]}),notificationInbox.clear(mac)]);
    delete devices[mac];
    try {saveDevices();} catch {devices[mac]=revoked;throw new Error('Device cleanup could not be saved');}
    res.json({success:true});
  } catch {res.status(503).json({error:'Device revoked; retry deletion to finish private data cleanup',device_revoked:true});}
});

app.post('/api/devices/:mac/config', requireAuth, (req, res) => {
  const mac = req.params.mac;
  if (devices[mac]) {
    if (req.body.voice_idle_timeout_seconds !== undefined && req.body.voice_idle_timeout_seconds !== null) {
      try { validateVoiceIdleSeconds(req.body.voice_idle_timeout_seconds); }
      catch (error) { return res.status(400).json({ error: error.message }); }
    }
    const previousIdleSeconds = resolveVoiceIdleSeconds(devices[mac].voice_idle_timeout_seconds, VOICE_IDLE_TIMEOUT_SECONDS);
    const idleChanged = req.body.voice_idle_timeout_seconds !== undefined &&
      resolveVoiceIdleSeconds(req.body.voice_idle_timeout_seconds, VOICE_IDLE_TIMEOUT_SECONDS) !==
      resolveVoiceIdleSeconds(devices[mac].voice_idle_timeout_seconds, VOICE_IDLE_TIMEOUT_SECONDS);
    devices[mac].prompt = req.body.prompt !== undefined ? req.body.prompt : devices[mac].prompt;
    devices[mac].llm_backend = req.body.llm_backend !== undefined ? req.body.llm_backend : devices[mac].llm_backend;
    devices[mac].gemini_model = req.body.gemini_model !== undefined ? req.body.gemini_model : devices[mac].gemini_model;
    devices[mac].qwen_model = req.body.qwen_model !== undefined ? req.body.qwen_model : devices[mac].qwen_model;
    devices[mac].gemini_voice = req.body.gemini_voice !== undefined ? req.body.gemini_voice : devices[mac].gemini_voice;
    devices[mac].qwen_voice = req.body.qwen_voice !== undefined ? req.body.qwen_voice : devices[mac].qwen_voice;
    devices[mac].llama_model = req.body.llama_model !== undefined ? req.body.llama_model : devices[mac].llama_model;
    devices[mac].llama_voice = req.body.llama_voice !== undefined ? req.body.llama_voice : devices[mac].llama_voice;
    devices[mac].input_transcription = req.body.input_transcription !== undefined ? req.body.input_transcription : devices[mac].input_transcription;
    devices[mac].output_transcription = req.body.output_transcription !== undefined ? req.body.output_transcription : devices[mac].output_transcription;
    devices[mac].enabled_mcp_devices = req.body.enabled_mcp_devices !== undefined ? req.body.enabled_mcp_devices : (devices[mac].enabled_mcp_devices || []);
    if (req.body.voice_idle_timeout_seconds === null) delete devices[mac].voice_idle_timeout_seconds;
    else if (req.body.voice_idle_timeout_seconds !== undefined) devices[mac].voice_idle_timeout_seconds = req.body.voice_idle_timeout_seconds;
    saveDevices();
    if (idleChanged) closeDeviceSessions(mac, 'voice_idle_setting_changed', mutationContext(req, 'device_config_save', {
      previous_idle_seconds: previousIdleSeconds, new_idle_seconds: resolveVoiceIdleSeconds(devices[mac].voice_idle_timeout_seconds, VOICE_IDLE_TIMEOUT_SECONDS)
    }));
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Device not found' });
  }
});

function remoteMcpAdmin(req, res, next) {
  audioAdmin(req, res, () => {
    if (!remoteMcp) return res.status(503).json({error:'Remote MCP configuration unavailable; check the saved configuration file'});
    next();
  });
}
function closeRemoteMcpSessions(id, reason, context) {
  for (const [deviceId, device] of Object.entries(devices)) {
    if (device.enabled_mcp_devices?.includes(id)) closeDeviceSessions(deviceId, reason, { ...context, connection_id: id });
  }
}
function agentAdmin(req, res, next) {
  audioAdmin(req, res, () => {
    if (!agentConnections || !endpointMcp) return res.status(503).json({ error: 'Agent configuration unavailable; check the saved configuration files' });
    next();
  });
}
app.get('/api/agent_connections', requireAuth, agentAdmin, (req, res) => res.json(agentConnections.list()));
app.post('/api/agent_connections', requireAuth, agentAdmin, async (req, res) => {
  try {
    const ingress = notificationIngress.status();
    if (ingress.invalidConfiguration) return res.status(503).json({ error: 'Fix notification ingress environment settings before creating an agent connection' });
    res.status(201).json(await agentConnections.create(req.body));
  }
  catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not save agent configuration; refresh the list before retrying' }); }
});
// Secrets are returned only by explicit authenticated setup/export operations,
// never by the polling/list endpoints or MCP tool results.
app.post('/api/agent_connections/:id/export', requireAuth, agentAdmin, (req, res) => {
  try { res.json(agentConnections.export(req.params.id)); }
  catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not export agent configuration' }); }
});
app.delete('/api/agent_connections/:id', requireAuth, agentAdmin, async (req, res) => {
  try {
    const serverId = await agentConnections.remove(req.params.id);
    const context = mutationContext(req, 'agent_connection_delete');
    closeRemoteMcpSessions(req.params.id, 'agent_connection_revoked', context);
    if (serverId) closeRemoteMcpSessions(serverId, 'agent_connection_revoked', context);
    for (const device of Object.values(devices)) device.enabled_mcp_devices = device.enabled_mcp_devices?.filter(id => id !== serverId && id !== req.params.id) || [];
    saveDevices();
    res.json({ success: true });
  } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not remove agent connection; check status before retrying' }); }
});
app.get('/api/remote_mcp_servers', requireAuth, remoteMcpAdmin, (req,res)=>res.json(remoteMcp.list()));
app.post('/api/remote_mcp_servers', requireAuth, remoteMcpAdmin, async(req,res)=>{
  try {
    const saved=await remoteMcp.save(req.body);
    closeRemoteMcpSessions(saved.id, 'remote_mcp_settings_changed', mutationContext(req, 'remote_mcp_save'));
    res.json({server:saved,reconnect_required:true});
  } catch(error) {res.status(error.status || 503).json({error:error.status ? error.message : 'Could not save remote MCP connection'});}
});
app.post('/api/remote_mcp_servers/:id/connect', requireAuth, remoteMcpAdmin, async(req,res)=>{
  try {
    closeRemoteMcpSessions(req.params.id, 'remote_mcp_refresh_requested', mutationContext(req, 'remote_mcp_refresh'));
    res.json({server:await remoteMcp.refresh(req.params.id),reconnect_required:true});
  } catch(error) {res.status(error.status || 503).json({error:error.status ? error.message : 'Could not refresh remote MCP connection'});}
});
app.delete('/api/remote_mcp_servers/:id', requireAuth, remoteMcpAdmin, async(req,res)=>{
  try {
    await remoteMcp.remove(req.params.id);
    closeRemoteMcpSessions(req.params.id, 'remote_mcp_removed', mutationContext(req, 'remote_mcp_delete'));
    for (const device of Object.values(devices)) device.enabled_mcp_devices=device.enabled_mcp_devices?.filter(id=>id!==req.params.id) || [];
    saveDevices();
    res.json({success:true,reconnect_required:true});
  } catch(error) {res.status(error.status || 503).json({error:error.status ? error.message : 'Could not remove remote MCP connection'});}
});

app.get('/api/mcp_devices', requireAuth, (req, res) => {
  res.set('Cache-Control','no-store');
  // Merge live connected state with persisted state
  const response = {};
  
  // Inject the built-in dashboard pseudo-device
  response[BUILTIN_MCP_ID] = {
    status: 'approved',
    name: 'Server internal · Dashboard & Pengingat',
    connected: true,
    tools: [...builtinTools, ...REMINDER_TOOLS].map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters
    }))
  };

  for (const [id, data] of Object.entries(mcpDevices)) {
    const {token,...publicData}=data;
    response[id] = { ...publicData, connected: false, tools: [] };
  }
  for (const [ws, info] of mcpClients.entries()) {
    if (!response[info.id]) response[info.id] = { status: 'pending', name: info.id };
    response[info.id].connected = true;
    response[info.id].tools = info.tools;
  }
  for (const server of remoteMcp?.list() || []) response[server.id]=server;
  for (const connection of agentConnections?.list() || []) {
    response[connection.id] = { ...connection, endpoint: true, status: 'approved', tools: endpointMcp?.tools(connection.id) || [] };
  }
  res.json(response);
});

app.post('/api/mcp_devices/:id/approve', requireAuth, (req, res) => {
  const id = req.params.id;
  if (!mcpDevices[id]) mcpDevices[id] = { name: id };
  mcpDevices[id].status = 'approved';
  saveMcpDevices();

  // Trigger tool discovery for the approved device if connected
  for (const [ws, info] of mcpClients.entries()) {
    if (info.id === id) {
      logger.info(`[MCP] Device ${id} approved. Requesting tools...`);
      sendMcpRequest(ws, 'tools/list', {}).then(res => {
        if (res.result && res.result.tools) {
          info.tools = res.result.tools;
          logger.info(`[MCP] Device ${id} registered ${res.result.tools.length} tools after approval.`);
        }
      }).catch(e => logger.error(`[MCP] Error requesting tools for ${id}: ${e.message}`));
    }
  }

  res.json({ success: true });
});

app.delete('/api/mcp_devices/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  if (mcpDevices[id]) {
    delete mcpDevices[id];
    saveMcpDevices();
    // Disconnect if currently connected
    for (const [ws, info] of mcpClients.entries()) {
      if (info.id === id) ws.close();
    }
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'MCP Device not found' });
  }
});

// Xiaozhi OTA / Discovery Endpoint
app.all(/^\/xiaozhi\/ota/, (req, res) => {
  handleOta(req, res);
});

function handleOta(req, res) {
  logger.info(`[OTA] ${req.method} request from ${req.headers['device-id'] || 'unknown'}`);
  // Do not log authorization headers or device credentials.

  if (req.method === 'POST') {
    // OTA bodies can contain identifying metadata; do not log them.
    const macAddress = req.body.mac_address || req.headers['device-id'] || '00:00:00:00:00:00';
    const uuid = req.body.uuid || req.headers['client-id'] || 'unknown_uuid';
    const clientId = req.headers['client-id'] || crypto.randomUUID();
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const wsProtocol = protocol === 'https' ? 'wss' : 'ws';

    // Check device registration
    let isAllowed = false;
    if (devices[macAddress]) {
      if (devices[macAddress].status === 'approved' && (devices[macAddress].uuid === uuid || (typeof devices[macAddress].mqtt_uuid === 'string' && devices[macAddress].mqtt_uuid === req.headers['client-id']) || (devices[macAddress].uuid === 'unknown_uuid' && !req.body.uuid && devices[macAddress].transport !== 'mqtt'))) {
        isAllowed = true;
      }
    } else {
      const pendingCount = Object.values(devices).filter(d => d.status === 'pending').length;
      if (pendingCount >= 10) {
        logger.warn(`[OTA] Max pending Xiaozhi devices reached. Rejecting ${macAddress}.`);
        return res.status(403).json({ status: "error", message: "Max pending devices reached" });
      }

      // Register as pending
      devices[macAddress] = {
        uuid,
        name: `Device ${macAddress}`,
        status: 'pending',
        token: crypto.randomBytes(16).toString('hex'),
        prompt: "You are a helpful assistant. Keep responses short.",
        input_transcription: true,
        output_transcription: true,
        enabled_mcp_devices: [BUILTIN_MCP_ID]
      };
      saveDevices();
      logger.info(`[OTA] New device ${macAddress} registered as pending.`);
    }

    let response;
    if (isAllowed) {
      logger.info(`[OTA] Allowed device ${macAddress} requested OTA. Returning valid token.`);
      response = {
        timestamp: new Date().toISOString(),
        server_time: deviceServerTime(DEVICE_TIMEZONE_OFFSET_MINUTES)
      };
      const device=devices[macAddress];
      if(device.transport==='mqtt') {
        const suppliedUuid=req.headers['client-id'] || uuid;
        if(!mqttConfig.configured || !hasDedicatedDeviceToken(macAddress) || suppliedUuid!==provisioningUuid(device)) {
          return res.status(503).json({error:'MQTT provisioning unavailable; choose WebSocket in dashboard to restore previous transport'});
        }
        try {response.mqtt=credentialsFor(macAddress,device,mqttConfig);}
        catch {return res.status(503).json({error:'MQTT identity unavailable'});}
      } else {
        response.websocket={url:WEBSOCKET_URL_FOR_ALLOWED_DEVICE,token:device.token||CLIENT_AUTH_TOKEN};
      }
    } else {
      logger.warn(`[OTA] Pending/Unapproved device ${macAddress} requested OTA.`);
      response = {
        timestamp: new Date().toISOString(),
        mqtt: {
          endpoint: MQTT_ENDPOINT,
          client_id: `GID_parrot@@@${macAddress.replace(/:/g, '_')}@@@${clientId}`,
          username: Buffer.from(JSON.stringify({ ip: req.socket.remoteAddress })).toString('base64'),
          password: crypto.randomBytes(32).toString('base64'),
          publish_topic: "device-server",
          subscribe_topic: "null"
        },
        websocket: {
          url: `${wsProtocol}://${req.headers.host}/`,
          token: INVALID_TEST_TOKEN
        },
        server_time: deviceServerTime(DEVICE_TIMEZONE_OFFSET_MINUTES),
        firmware: { version: "1.0.0", url: "" },
        activation: { code: "123456", message: "Parrot Relay\nWaiting for Approval", challenge: crypto.randomUUID() }
      };
    }
    // OTA response includes credentials; never log the payload.
    res.json(response);
  } else {
    const responsePayload = { status: "ok", message: "Parrot Relay OTA endpoint", timestamp: new Date().toISOString() };
    logger.debug(`[OTA] Response Payload: ${JSON.stringify(responsePayload)}`);
    res.json(responsePayload);
  }
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', passenger: true, pid: process.pid });
});

// Create HTTP Server
const server = http.createServer(app);

// WebSockets
const wssXiaozhi = new WebSocket.Server({ noServer: true });
const wssMcp = new WebSocket.Server({ noServer: true });
const wssMcpEndpoint = new WebSocket.Server({ noServer: true, maxPayload: MCP_ENDPOINT_MAX_PAYLOAD, perMessageDeflate: false });

// Handle Upgrades
server.on('upgrade', (request, socket, head) => {
  let pathname;
  try { pathname = new URL(request.url, 'http://localhost').pathname; }
  catch { socket.destroy(); return; }
  if (pathname === '/xiaozhi/v1' || pathname === '/xiaozhi/v1/') {
    wssXiaozhi.handleUpgrade(request, socket, head, (ws) => {
      wssXiaozhi.emit('connection', ws, request);
    });
  } else if (pathname === '/mcp' || pathname === '/mcp/') {
    wssMcp.handleUpgrade(request, socket, head, (ws) => {
      wssMcp.emit('connection', ws, request);
    });
  } else if (pathname === '/mcp_endpoint/mcp' || pathname === '/mcp_endpoint/mcp/') {
    const sender = ADMIN_PASSWORD_READY && endpointMcp?.authenticate(request);
    if (!sender) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wssMcpEndpoint.handleUpgrade(request, socket, head, ws => {
      void endpointMcp.accept(ws, sender).catch(() => ws.close(1011, 'MCP endpoint unavailable'));
    });
  } else {
    socket.destroy();
  }
});

// MCP Server Logic
wssMcp.on('connection', (ws, req) => {
  const mcpUrl = new URL(req.url, `http://${req.headers.host}`);
  const clientId = mcpUrl.searchParams.get('device_id') || crypto.randomUUID();
  if (clientId === BUILTIN_MCP_ID || /^(remote|agent)-[0-9a-f-]{36}$/.test(clientId)) {
    ws.close(1008,'Reserved MCP connection ID');
    return;
  }
  const token = mcpUrl.searchParams.get('token');

  let mcpDevice = mcpDevices[clientId];

  if (!mcpDevice) {
    const pendingCount = Object.values(mcpDevices).filter(d => d.status === 'pending').length;
    if (pendingCount >= 10) {
      logger.warn(`[MCP] Max pending MCP devices reached. Rejecting ${clientId}.`);
      ws.close(1008, 'Max pending devices reached');
      return;
    }
    
    mcpDevice = {
      name: clientId,
      status: 'pending'
    };
    if (token) mcpDevice.token = token;
    mcpDevices[clientId] = mcpDevice;
    saveMcpDevices();
  } else if (mcpDevice.token && token !== mcpDevice.token) {
    logger.warn(`[MCP] Authentication failed for ${clientId}. Invalid token.`);
    ws.close(1008, 'Unauthorized');
    return;
  } else if (!mcpDevice.token && token) {
    // Legacy MCP device or previously unauthenticated device, lock it to the new token
    mcpDevice.token = token;
    saveMcpDevices();
  }

  logger.info(`[MCP] New client connected: ${clientId} from ${req.socket.remoteAddress}`);

  // Keep-alive ping to prevent aggressive idle timeouts from Nginx/Node
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 3000);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      logger.debug(`[MCP] Message received from ${clientId}`);

      let mcpId = data.id;
      if (mcpId !== undefined && typeof mcpId === 'string' && !isNaN(Number(mcpId))) {
          mcpId = Number(mcpId);
      }

      if (mcpId !== undefined && mcpCallbacks.has(mcpId)) {
        mcpCallbacks.get(mcpId)(data);
        mcpCallbacks.delete(mcpId);
      } else if (data.method) {
        logger.info(`[MCP] Received unhandled method ${data.method} from ${clientId}`);
      }
    } catch (e) {
      logger.error(`[MCP] Failed to parse message from ${clientId}`);
    }
  });

  ws.on('close', () => {
    logger.info(`[MCP] Client disconnected: ${clientId}`);
    mcpClients.delete(ws);
    clearInterval(pingInterval);
  });

  setupMcpClient(ws, clientId).catch(e => logger.error(`[MCP] Setup failed for ${clientId}: ${e.message}`));
});

// Xiaozhi Voice Session Logic
wssXiaozhi.on('connection', (ws, req) => {
  const sessionId = crypto.randomUUID();
  const macAddress = req.headers['device-id'] || 'unknown';
  let providerAttempt = 0;
  const trace = createSessionTrace({ logger, sessionId, deviceId: macAddress,
    context: () => ({ attempt: providerAttempt }), secrets: [...logSecrets, devices[macAddress]?.token, CLIENT_AUTH_TOKEN] });
  trace.event('device.connection_requested', { peer: req.socket.remoteAddress, path: '/xiaozhi/v1/' });
  logger.info(`[${sessionId}] New Xiaozhi connection attempt...`);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const authHeader = req.headers['authorization'];
  let token = url.searchParams.get('token');

  if (authHeader && authHeader.startsWith('Bearer ')) token = authHeader.substring(7);

  let deviceConfig = devices[macAddress];
  
  if (!deviceConfig || deviceConfig.status !== 'approved') {
    trace.event('device.auth_rejected', { reason: 'device_not_approved', close_code: 1008 }, 'warn');
    logger.warn(`[${sessionId}] Authentication failed. Device ${macAddress} not registered.`);
    ws.close(1008, 'Unauthorized');
    return;
  }
  
  const expectedToken = deviceConfig.token || CLIENT_AUTH_TOKEN;

  if (token !== expectedToken) {
    trace.event('device.auth_rejected', { reason: 'invalid_token', close_code: 1008 }, 'warn');
    logger.warn(`[${sessionId}] Authentication failed.`);
    ws.close(1008, 'Unauthorized');
    return;
  }

  const authenticatedClientId=req.headers['client-id'];
  if(!provisioningUuid(deviceConfig) && hasDedicatedDeviceToken(macAddress) &&
      typeof authenticatedClientId==='string' && /^[A-Za-z0-9_-]{8,128}$/.test(authenticatedClientId)) {
    deviceConfig.mqtt_uuid=authenticatedClientId;
    saveDevices();
  }

  // Ensure default config fallback
  deviceConfig = deviceConfig || {
    prompt: "You are a helpful assistant. Keep responses short.",
    input_transcription: true,
    output_transcription: true,
    enabled_mcp_devices: []
  };

  trace.event('device.authenticated', { dedicated_credential: hasDedicatedDeviceToken(macAddress) });
  voiceTraces.set(ws, trace);
  logger.info(`[${sessionId}] Authenticated successfully. Device: ${macAddress}`);
  if (!activeVoiceSockets.has(macAddress)) activeVoiceSockets.set(macAddress, new Set());
  activeVoiceSockets.get(macAddress).add(ws);

  let provider = null;
  let connectingProvider = null;
  let sessionStarting = false;
  let sessionClosed = false;
  let deviceHeartbeat = null;
  let providerRetryTimer = null;
  const recovery = new LiveRecovery();
  let resumptionState = null;
  const toolHistory = new Map();
  let providerGeneration = 0;
  let providerToolAbort = null;
  let cancelMcpDiscovery = null;
  let mcpDiscoveryPending = false;
  let inboxAnnouncement = null;
  const remoteToolRoutes = new Map();
  const endpointToolRoutes = new Map();
  let memoryTurns = null;
  let isSpeaking = false;
  let modelDone = false;
  let audioOutputQueue = [];
  let outputRemainder = Buffer.alloc(0);
  let playbackPrimed = false;
  let playbackReadyAt = 0;
  let downlinkBlockedAt = null;
  let audioSendInterval = null;
  const FRAME_DURATION_MS = 60;
  let outputTranscriptionBuffer = '';
  let ttsTextQueue = [];
  let finishReason = null;
  let lastSpeechLogAt = 0;
  let reminderRequestSequence = 0;
  let reminderInputOpen = false;
  const runReminderTool = createReminderTools({ service: reminderService, deviceId: macAddress,
    requestScope: () => {
      // A tool can arrive before its delayed input transcript. Give both the
      // same request scope, including when a provider reconnects mid-request.
      if (!reminderInputOpen) { reminderInputOpen = true; reminderRequestSequence++; }
      return `${sessionId}:${reminderRequestSequence}`;
    },
    allowed: () => !sessionClosed && devices[macAddress]?.status === 'approved' && hasDedicatedDeviceToken(macAddress),
    maxChars: inboxToolMaxChars
  });
  const metrics = { input_packets: 0, pcm_frames: 0, speech_frames: 0, provider_audio_chunks: 0,
    playback_packets: 0, buffer_dropped: 0, input_gap_frames: 0, playback_underruns: 0, turns: 0, tool_calls: 0 };
  const audioInput = new PacedAudioInput({
    ready: () => Boolean(provider), send: chunk => provider?.sendAudio(chunk),
    end: () => provider?.endAudio ? provider.endAudio() : true,
    onDrop: count => { metrics.buffer_dropped += count; },
    onEnd: () => trace.event('audio.input_ended', { reason: 'listen_stop_or_stream_gap' })
  });
  let lastTtsTime = 0;
  let currentTtsDelay = 0;
  const voiceIdle = new VoiceIdleTimer({
    timeoutMs: resolveVoiceIdleSeconds(deviceConfig.voice_idle_timeout_seconds, VOICE_IDLE_TIMEOUT_SECONDS) * 1000,
    threshold: VOICE_ACTIVITY_THRESHOLD,
    onIdle: () => finishVoiceSession('silence_timeout'),
    onEvent: (event, fields) => trace.event(event, fields)
  });

  trace.event('session.configured', { backend: deviceConfig.llm_backend || LLM_BACKEND,
    idle_seconds: voiceIdle.timeoutMs / 1000, idle_source: deviceConfig.voice_idle_timeout_seconds == null ? 'server' : 'device',
    activity_threshold: VOICE_ACTIVITY_THRESHOLD, selected_mcp_count: deviceConfig.enabled_mcp_devices?.length || 0 });
  const traceInterval = setInterval(() => {
    trace.event('session.status', { ...voiceIdle.snapshot(), metrics, provider_ready: Boolean(provider),
      provider_starting: sessionStarting, retry_pending: Boolean(providerRetryTimer), buffered_frames: audioInput.length,
      playback_queue: audioOutputQueue.length, socket_buffered_bytes: ws.bufferedAmount,
      speaking: isSpeaking, heartbeat: deviceHeartbeat?.snapshot() });
  }, 15000);
  traceInterval.unref();

  function queueTtsText(text) {
    if (!text) return;
    text = text.trim();
    if (text.length === 0) return;
    voiceIdle.hold('playback');
    
    while (text.length > 120) {
        ttsTextQueue.push(text.substring(0, 120));
        text = text.substring(120);
    }
    if (text.length > 0) ttsTextQueue.push(text);
    
    scheduleAudioSend();
  }

  const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 1, rate: 16000 });
  const encoder = new prism.opus.Encoder({ frameSize: 1440, channels: 1, rate: 24000 });

  decoder.on('data', (pcmChunk) => {
    if (sessionClosed) return;
    metrics.pcm_frames++;
    if (voiceIdle.pcm(pcmChunk)) {
      metrics.speech_frames++;
      if (!lastSpeechLogAt || Date.now() - lastSpeechLogAt >= 10000) {
        lastSpeechLogAt = Date.now();
        trace.event('audio.activity_detected', { ...voiceIdle.snapshot(), pcm_bytes: pcmChunk.length });
      }
    }
    audioInput.push(pcmChunk);
  });

  decoder.on('error', err => { trace.event('audio.decode_error', { error: err }, 'error'); });

  encoder.on('data', (opusChunk) => {
    if (sessionClosed) return;
    voiceIdle.hold('playback');
    if (audioOutputQueue.length >= 1000) {
      trace.event('audio.downlink_overflow', { queued_frames: audioOutputQueue.length }, 'warn');
      finishVoiceSession('audio_backpressure'); return;
    }
    audioOutputQueue.push(opusChunk);
    scheduleAudioSend();
  });

  encoder.on('error', (err) => {
    inboxAnnouncement?.discard();
    trace.event('audio.encode_error', { error: err }, 'error');
  });

  function writeOutputAudio(audio, flush = false) {
    const bytes = Buffer.concat([outputRemainder, audio]);
    const fullBytes = bytes.length - bytes.length % 2880; // 60 ms PCM16 mono at 24 kHz
    outputRemainder = Buffer.from(bytes.subarray(fullBytes));
    for (let offset = 0; offset < fullBytes && !sessionClosed; offset += 2880) encoder.write(bytes.subarray(offset, offset + 2880));
    if (flush && outputRemainder.length && !sessionClosed) {
      const tail = Buffer.alloc(2880); outputRemainder.copy(tail);
      outputRemainder = Buffer.alloc(0); encoder.write(tail);
    }
  }

  function scheduleAudioSend() {
    if (!audioSendInterval) {
      audioSendInterval = setInterval(() => {
        if (sessionClosed || ws.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (ws.bufferedAmount > 65536 || modelDone && audioOutputQueue.length === 0 && ws.bufferedAmount > 0) {
          if (downlinkBlockedAt === null) {
            downlinkBlockedAt = now;
            trace.event('audio.downlink_blocked', { buffered_bytes: ws.bufferedAmount }, 'warn');
          }
          if (now - downlinkBlockedAt >= 15000) finishVoiceSession('audio_backpressure');
          return;
        }
        if (downlinkBlockedAt !== null) {
          trace.event('audio.downlink_recovered', { blocked_ms: now - downlinkBlockedAt });
          downlinkBlockedAt = null;
        }
        
        if (ttsTextQueue.length > 0 && now - lastTtsTime >= currentTtsDelay) {
          const textToSend = ttsTextQueue.shift();
          const payload = { type: 'tts', state: 'sentence_start', session_id: sessionId, text: textToSend };
          logger.debug(`[${sessionId}] Sending Xiaozhi ${payload.type} ${payload.state || ''}`);
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
          lastTtsTime = now;

          // Calculate delay for this message based on its length to give the user time to read.
          // We use a base of 2000ms minimum, scaling up linearly with the character count.
          currentTtsDelay = Math.max(2000, textToSend.length * 80);

          // If the text queue is backing up, dynamically reduce the delay to catch up with audio
          if (ttsTextQueue.length > 2) currentTtsDelay = Math.max(1000, textToSend.length * 50);
          if (ttsTextQueue.length > 4) currentTtsDelay = Math.max(500, textToSend.length * 30);
        }

        if (audioOutputQueue.length > 0) {
          if (!playbackPrimed && audioOutputQueue.length < 3 && !modelDone && now < playbackReadyAt) return;
          playbackPrimed = true;
          const chunkToSend = audioOutputQueue.shift();
          if (ws.readyState === WebSocket.OPEN) {
            voiceIdle.hold('playback');
            ws.send(chunkToSend, error => {
              if (error && !sessionClosed) finishVoiceSession('audio_send_failed');
            });
            metrics.playback_packets++;
            inboxAnnouncement?.audioSent();
          }
        } else if ((modelDone || !isSpeaking) && ttsTextQueue.length === 0) {
          if (isSpeaking) {
            isSpeaking = false;
            const payload = { type: 'tts', state: 'stop', session_id: sessionId };
            logger.debug(`[${sessionId}] Sending Xiaozhi ${payload.type} ${payload.state || ''}`);
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
          }
          clearInterval(audioSendInterval);
          audioSendInterval = null;
          voiceIdle.release('playback');
          trace.event('audio.playback_drained', { turn_complete: modelDone, packets_sent: metrics.playback_packets });
          if (modelDone && ws.readyState === WebSocket.OPEN) {
            inboxAnnouncement?.playbackComplete().catch(error => trace.event('inbox.ack_failed', { error }, 'warn'));
          }
          modelDone = false;
          playbackPrimed = false;
        } else if (playbackPrimed) {
          metrics.playback_underruns++;
          playbackPrimed = false;
          playbackReadyAt = now + 180;
        }
      }, FRAME_DURATION_MS);
    }
  }

  async function startSession() {
    if (sessionStarting || provider || sessionClosed) {
      trace.event('provider.start_skipped', { provider_ready: Boolean(provider), provider_starting: sessionStarting, session_closed: sessionClosed }, 'debug');
      return;
    }
    const attempt = ++providerAttempt;
    const attemptStarted = performance.now();
    trace.event('provider.preparing', { attempt });
    if (providerRetryTimer) clearTimeout(providerRetryTimer);
    providerRetryTimer = null;
    sessionStarting = true;
    const generation = ++providerGeneration;
    const toolAbort = new AbortController();
    providerToolAbort?.abort();
    providerToolAbort = toolAbort;
    voiceIdle.start();
    voiceIdle.hold('provider_setup');
    inboxAnnouncement?.discard();
    memoryTurns?.close();
    inboxAnnouncement = null;
    memoryTurns = null;
    remoteToolRoutes.clear();
    endpointToolRoutes.clear();
    try {
      // Gather tools from approved and enabled MCP clients
      const toolsMap = new Map();
      const enabledMcpSet = new Set(deviceConfig.enabled_mcp_devices || []);

      if (enabledMcpSet.has(BUILTIN_MCP_ID)) {
        for (const bt of builtinTools) toolsMap.set(bt.name, bt);
      }

      for (const [mcpWs, info] of mcpClients.entries()) {
        const mcpStatus = mcpDevices[info.id]?.status;

        if (mcpStatus === 'approved' && enabledMcpSet.has(info.id)) {
          for (const t of info.tools) {
            const toolDef = {
              name: t.name,
              description: t.description || 'No description provided.'
            };
            if (t.inputSchema && t.inputSchema.properties && Object.keys(t.inputSchema.properties).length > 0) {
              toolDef.parameters = JSON.parse(JSON.stringify(t.inputSchema));
              if (toolDef.parameters.type && typeof toolDef.parameters.type === 'string') {
                toolDef.parameters.type = toolDef.parameters.type.toLowerCase();
              }
              if (toolDef.parameters.additionalProperties === undefined) {
                toolDef.parameters.additionalProperties = false;
              }
            } else {
               toolDef.parameters = { type: "object", properties: {}, additionalProperties: false };
            }
            toolsMap.set(toolDef.name, toolDef);
          }
        }
      }

      const sessionBackend=deviceConfig.llm_backend || LLM_BACKEND;
      if (sessionBackend === 'gemini' && hasDedicatedDeviceToken(macAddress) && endpointMcp) {
        for (const [name, route] of endpointMcp.routes(enabledMcpSet, macAddress)) {
          if (toolsMap.has(name)) continue;
          toolsMap.set(name, route.definition);
          endpointToolRoutes.set(name, route);
        }
      }
      if (sessionBackend === 'gemini' && hasDedicatedDeviceToken(macAddress) && remoteMcp) {
        await remoteMcp.ensure(enabledMcpSet);
        if (sessionClosed) return;
        for (const [name,route] of remoteMcp.routes(enabledMcpSet)) {
          if (toolsMap.has(name)) continue;
          toolsMap.set(name,route.definition);
          remoteToolRoutes.set(name,route);
        }
      }
      if(canUseInboxTools(sessionBackend,hasDedicatedDeviceToken(macAddress))) {
        for(const tool of INBOX_TOOLS) toolsMap.set(tool.name,tool);
        for(const tool of REMINDER_TOOLS) toolsMap.set(tool.name,tool);
      }
      const mcpTools = Array.from(toolsMap.values());
      const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
      
      let config = { ...deviceConfig };
      config.prompt = deviceConfig.prompt;
      if (remoteToolRoutes.size || endpointToolRoutes.size) config.prompt=(config.prompt || 'You are a helpful assistant. Keep responses short.')+'\n'+REMOTE_MCP_INSTRUCTION;
      if(canUseInboxTools(activeBackend,hasDedicatedDeviceToken(macAddress))) config.prompt=(config.prompt || 'You are a helpful assistant. Keep responses short.')+'\n'+INBOX_INSTRUCTION;
      if(canUseInboxTools(activeBackend,hasDedicatedDeviceToken(macAddress))) config.prompt+='\n'+REMINDER_INSTRUCTION;
      config.input_transcription = deviceConfig.input_transcription;
      config.output_transcription = deviceConfig.output_transcription;
      if (canUseInboxTools(activeBackend,hasDedicatedDeviceToken(macAddress))) {
        // Internal transcripts confirm user speech and exact title announcements,
        // even when subtitle display and conversation memory are disabled.
        config.input_transcription = true;
        config.output_transcription = true;
        inboxAnnouncement = createInboxAnnouncement({
          inbox:notificationInbox,deviceId:macAddress,maxChars:inboxToolMaxChars,
          isActive:()=>generation === providerGeneration && !sessionClosed && devices[macAddress]?.status === 'approved' && hasDedicatedDeviceToken(macAddress)
        });
      }
      // Memory reads occur only before session setup, never on audio chunks.
      if (activeBackend === 'gemini' && hasDedicatedDeviceToken(macAddress)) {
        try {
          const snapshot = await memoryStore.get(macAddress);
          trace.event('memory.context_loaded', { enabled: snapshot.enabled, attempt });
          if (snapshot.enabled) {
            config.prompt = (config.prompt || 'You are a helpful assistant. Keep responses short.') + '\n' + memoryStore.context(snapshot);
            config.input_transcription = true;
            config.output_transcription = true;
            memoryTurns = new TurnBuffer({ store: memoryStore, deviceId: macAddress, epoch: snapshot.epoch });
          }
        } catch (error) {
          trace.event('memory.context_failed', { attempt, error }, 'warn');
          logger.warn(`[${sessionId}] Memory unavailable; starting without saved context.`);
        }
      }
      if (sessionClosed) return;

      let newProvider;
      const providerConfigDef = providersConfig.find(p => p.id === activeBackend);
      const isConfigured = providerConfigDef && (!providerConfigDef.envVars || providerConfigDef.envVars.every(envVar => !!process.env[envVar]));

      if (!isConfigured) {
          trace.event('provider.configuration_rejected', { attempt, backend: activeBackend,
            missing_env: providerConfigDef?.envVars?.filter(name => !process.env[name]) || [] }, 'error');
          logger.error(`[${sessionId}] Provider ${activeBackend} is missing required environment variables.`);
          if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: `Server Error: Provider ${activeBackend} is not properly configured on the server.` }));
          }
          ws.close(1011, "Provider not configured");
          return;
      }

      if (activeBackend === 'gemini') {
          config.apiKey = GEMINI_API_KEY;
          config.model = deviceConfig.gemini_model || GEMINI_MODEL;
          config.voice = deviceConfig.gemini_voice || GEMINI_VOICE;
          // Saved memory grows between turns; a resumed session already owns
          // that context. Reuse its original prompt only while settings/tools match.
          config.resumptionSignature = JSON.stringify({ device: deviceConfig, tools: mcpTools });
          if (resumptionState?.signature === config.resumptionSignature) {
              config.resumptionHandle = resumptionState.handle;
              config.prompt = resumptionState.prompt;
          } else resumptionState = null;
          if (!config.resumptionHandle) toolHistory.clear();
          newProvider = new GeminiProvider(config);
      } else if (activeBackend === 'qwen' || activeBackend === 'qwen_realtime' || activeBackend === 'qwen_omni') {
          config.apiKey = DASHSCOPE_API_KEY;
          config.model = deviceConfig.qwen_model || QWEN_MODEL;
          config.voice = deviceConfig.qwen_voice || QWEN_VOICE;

          if (activeBackend === 'qwen_omni') {
              config.input_transcription = false; // Disable input transcription for Qwen Omni
          }

          if (activeBackend === 'qwen_realtime' || (activeBackend === 'qwen' && config.model.includes('realtime'))) {
              newProvider = new QwenRealtimeProvider(config);
          } else {
              newProvider = new QwenOmniProvider(config);
          }
      } else if (activeBackend === 'llama_liquid_audio_server') {
          config.url = process.env.LIQUID_SERVER_URL;
          config.model = deviceConfig.llama_model || providerConfigDef.models[0].id;
          config.voice = deviceConfig.llama_voice || providerConfigDef.voices[0];
          newProvider = new LlamaLiquidAudioServerProvider(config);
      } else if (activeBackend === 'llama_liquid_interleaved') {
          config.url = process.env.LIQUID_SERVER_URL;
          config.model = deviceConfig.llama_model || providerConfigDef.models[0].id;
          config.voice = deviceConfig.llama_voice || providerConfigDef.voices[0];
          newProvider = new LlamaLiquidInterleavedProvider(config);
      } else {
          trace.event('provider.configuration_rejected', { attempt, backend: activeBackend, reason: 'unknown_backend' }, 'error');
          logger.error(`[${sessionId}] Unknown backend: ${activeBackend}`);
          if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: `Server Error: Unknown backend ${activeBackend}` }));
          }
          ws.close(1011, "Unknown backend");
          return;
      }

      connectingProvider = newProvider;
      const pendingToolCalls = new Map();
      const isCurrentProvider = () => !sessionClosed && connectingProvider === newProvider;
      newProvider.on('resumption_update', update => {
          if (!isCurrentProvider()) return;
          // Never restore a checkpoint across an unresolved tool side effect.
          if (update.resumable && pendingToolCalls.size === 0) {
              if (update.handle) resumptionState = { handle: update.handle, signature: config.resumptionSignature, prompt: config.prompt };
          } else resumptionState = null;
      });
      newProvider.on('diagnostic', diagnostic => {
          if (isCurrentProvider()) trace.event(diagnostic.event, { ...diagnostic, attempt });
      });
      const sendToolResponse = newProvider.sendToolResponse.bind(newProvider);
      newProvider.sendToolResponse = (callId, name, response) => {
          if (!isCurrentProvider()) return;
          voiceIdle.hold('response');
          const call = pendingToolCalls.get(callId);
          pendingToolCalls.delete(callId);
          if (toolHistory.has(callId)) toolHistory.set(callId, { name, response });
          let failed = false;
          try { const result = JSON.parse(response); failed = Boolean(result?.error || result?.isError); } catch {}
          trace.event('tool.response_submitted', { attempt, call_id: callId, tool: name, failed,
            duration_ms: call ? Math.round(performance.now() - call.started) : null, response_chars: typeof response === 'string' ? response.length : null }, failed ? 'warn' : 'info');
          try { return sendToolResponse(callId, name, response); }
          finally { voiceIdle.release(`tool:${callId}`); }
      };
      newProvider.on('listen_stop', () => {
          if (!isCurrentProvider()) return;
          voiceIdle.hold('response');
          if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'listen', state: 'stop', session_id: sessionId }));
              trace.event('device.listen_stopped', { attempt, reason: 'provider_response' });
          }
      });

      newProvider.on('connected', () => {
          if (!isCurrentProvider()) { newProvider.close(); return; }
          voiceIdle.start();
          voiceIdle.resume();
          recovery.connected();
          trace.event('provider.ready', { attempt, backend: activeBackend, model: config.model, voice: config.voice,
            setup_ms: Math.round(performance.now() - attemptStarted), buffered_frames: audioInput.length,
            resumed: Boolean(config.resumptionHandle) });
          logger.info(`[${sessionId}] Connected to ${activeBackend} API`);
          if (ws.readyState === WebSocket.OPEN) {
              const payload = { type: 'listen', state: 'start', session_id: sessionId };
              ws.send(JSON.stringify(payload));
              trace.event('device.listen_started', { attempt });
          }
          
          provider = newProvider;
          
          // PacedAudioInput drains unsent frames at 20 ms, never in a reconnect burst.
      });

      newProvider.on('audio_output', (audioBuf) => {
          if (!isCurrentProvider()) return;
          metrics.provider_audio_chunks++;
          voiceIdle.hold('response');
          voiceIdle.hold('playback');
          modelDone = false;
          if (!isSpeaking) {
              isSpeaking = true;
              playbackPrimed = false;
              playbackReadyAt = Date.now() + 180;
              trace.event('audio.output_started', { attempt, first_chunk_bytes: audioBuf.length });
              ws.send(JSON.stringify({ type: 'tts', state: 'start', session_id: sessionId }));
          }
          writeOutputAudio(audioBuf);
      });

      newProvider.on('input_transcription', (text) => {
          if (!isCurrentProvider()) return;
          if (typeof text === 'string' && text.trim() && !reminderInputOpen) { reminderInputOpen = true; reminderRequestSequence++; }
          if (typeof text === 'string' && text.trim()) { voiceIdle.activity(); trace.event('transcription.input', { attempt, chars: text.length }, 'debug'); }
          inboxAnnouncement?.addInput(text);
          memoryTurns?.addInput(text);
          if (deviceConfig.input_transcription && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stt', session_id: sessionId, text }));
      });

      newProvider.on('output_transcription', (text) => {
          if (!isCurrentProvider()) return;
          if (typeof text === 'string' && text.trim()) { voiceIdle.hold('response'); trace.event('transcription.output', { attempt, chars: text.length }, 'debug'); }
          inboxAnnouncement?.addOutput(text);
          memoryTurns?.addOutput(text);
          if (!deviceConfig.output_transcription) return;
          outputTranscriptionBuffer += text;
          let match;
          while ((match = outputTranscriptionBuffer.match(/.*?([。！？.!?\n]+)/))) {
              const textToSend = match[0];
              outputTranscriptionBuffer = outputTranscriptionBuffer.substring(textToSend.length);
              queueTtsText(textToSend);
          }
          if (outputTranscriptionBuffer.length >= 120) {
              queueTtsText(outputTranscriptionBuffer);
              outputTranscriptionBuffer = '';
          }
      });

      newProvider.on('turn_complete', () => {
          if (!isCurrentProvider()) return;
          reminderInputOpen = false;
          writeOutputAudio(Buffer.alloc(0), true);
          metrics.turns++;
          trace.event('provider.turn_complete', { attempt, turn: metrics.turns, playback_queue: audioOutputQueue.length });
          voiceIdle.release('response');
          inboxAnnouncement?.turnComplete();
          if (memoryTurns) memoryTurns.complete().catch(error => trace.event('memory.write_failed', { attempt, error }, 'warn'));
          if (outputTranscriptionBuffer.length > 0 && deviceConfig.output_transcription) {
              queueTtsText(outputTranscriptionBuffer);
              outputTranscriptionBuffer = '';
          }
          modelDone = true;
      });

      newProvider.on('interrupted', () => {
          if (!isCurrentProvider()) return;
          trace.event('provider.interrupted', { attempt, playback_queue: audioOutputQueue.length });
          voiceIdle.release('response');
          voiceIdle.release('playback');
          inboxAnnouncement?.discard();
          memoryTurns?.discard();
          outputTranscriptionBuffer = '';
          if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'abort', session_id: sessionId, reason: 'interrupted' }));
              if (isSpeaking) {
                  ws.send(JSON.stringify({ type: 'tts', state: 'stop', session_id: sessionId }));
              }
          }
          isSpeaking = false;
          modelDone = false;
          audioOutputQueue = [];
          outputRemainder = Buffer.alloc(0);
          playbackPrimed = false;
          ttsTextQueue = [];
      });

      newProvider.on('tool_call', (callId, name, args) => {
          if (!isCurrentProvider()) return;
          resumptionState = null;
          const previous = toolHistory.get(callId);
          if (previous) {
              newProvider.sendToolResponse(callId, name, previous.name === name && previous.response !== undefined ? previous.response :
                JSON.stringify({ error: 'Previous execution status is unknown. Do not repeat this action automatically.' }));
              return;
          }
          // Keep recent results across reconnects; never automatically re-run a tool ID.
          if (toolHistory.size >= 256) toolHistory.delete(toolHistory.keys().next().value);
          toolHistory.set(callId, { name });
          metrics.tool_calls++;
          pendingToolCalls.set(callId, { started: performance.now() });
          trace.event('tool.requested', { attempt, call_id: callId, tool: name,
            source_tool: endpointToolRoutes.get(name)?.name || remoteToolRoutes.get(name)?.name || name,
            route: REMINDER_TOOL_NAMES.has(name) ? 'reminder' : endpointToolRoutes.has(name) ? 'endpoint' : remoteToolRoutes.has(name) ? 'remote_http' : name.startsWith('notifications_') ? 'inbox' : 'device_or_builtin' });
          voiceIdle.hold(`tool:${callId}`);
          voiceIdle.hold('response');
          if (REMINDER_TOOL_NAMES.has(name)) {
            if (!canUseInboxTools(activeBackend, hasDedicatedDeviceToken(macAddress))) {
              newProvider.sendToolResponse(callId, name, JSON.stringify({error:'Reminder tools unavailable'})); return;
            }
            runReminderTool(name, args).then(result => {
              if (isCurrentProvider()) newProvider.sendToolResponse(callId, name, JSON.stringify(result));
            }).catch(error => {
              if (isCurrentProvider()) {
                trace.event('tool.error', { attempt, call_id: callId, tool: name, code: error.code }, 'warn');
                newProvider.sendToolResponse(callId, name, JSON.stringify({error: error.code === 'INBOX_CORRUPT' ? 'Reminder storage unavailable; do not retry automatically' : error.message}));
              }
            });
            return;
          }
          const endpointRoute = endpointToolRoutes.get(name);
          if (endpointRoute) {
            if (!devices[macAddress]?.enabled_mcp_devices?.includes(endpointRoute.connectionId)) {
              newProvider.sendToolResponse(callId, name, JSON.stringify({ error: 'MCP endpoint is no longer selected for this device' }));
              return;
            }
            endpointMcp.call(endpointRoute, args, { deviceId: macAddress, sessionId, signal: toolAbort.signal }).then(result => {
              if (isCurrentProvider()) newProvider.sendToolResponse(callId, name, JSON.stringify(result));
            }).catch(error => {
              if (isCurrentProvider()) trace.event('tool.error', { attempt, call_id: callId, tool: name, error }, 'warn');
              if (isCurrentProvider()) newProvider.sendToolResponse(callId, name, JSON.stringify({ error: error.message }));
            });
            return;
          }
          const remoteRoute=remoteToolRoutes.get(name);
          if (remoteRoute) {
            if (!hasDedicatedDeviceToken(macAddress) || devices[macAddress]?.status !== 'approved' ||
                !devices[macAddress]?.enabled_mcp_devices?.includes(remoteRoute.serverId)) {
              newProvider.sendToolResponse(callId,name,JSON.stringify({error:'Remote MCP connection is no longer enabled for this device'}));
              return;
            }
            remoteMcp.call(remoteRoute,args,{deviceId:macAddress,sessionId,signal:toolAbort.signal}).then(result=>{
              if(isCurrentProvider()) newProvider.sendToolResponse(callId,name,JSON.stringify(result));
            }).catch(error=>{
              if(isCurrentProvider()) trace.event('tool.error', { attempt, call_id: callId, tool: name, error }, 'warn');
              if(isCurrentProvider()) newProvider.sendToolResponse(callId,name,JSON.stringify({error:error.message}));
            });
            return;
          }
          if(isInboxToolCall(name,activeBackend,hasDedicatedDeviceToken(macAddress))) {
            const run=createInboxTools({inbox:notificationInbox,deviceId:macAddress,maxChars:inboxToolMaxChars,announcement:inboxAnnouncement});
            run(name,args).then(result=>{
              if(isCurrentProvider()) newProvider.sendToolResponse(callId,name,JSON.stringify(result));
            }).catch(error=>{
              if(isCurrentProvider()) trace.event('tool.error', { attempt, call_id: callId, tool: name, error }, 'warn');
              if(isCurrentProvider()) newProvider.sendToolResponse(callId,name,JSON.stringify({error:'Notification request invalid or inbox unavailable'}));
            });
            return;
          }
          logger.info(`[${sessionId}] Provider requested tool call: ${name}`);

          if (name === 'server.get_pending_devices') {
              const pendingDevices = [];
              for (const [mac, data] of Object.entries(devices)) {
                  if (data.status === 'pending') pendingDevices.push({ id: mac, type: 'xiaozhi', name: data.name || mac });
              }
              for (const [id, data] of Object.entries(mcpDevices)) {
                  if (data.status === 'pending') pendingDevices.push({ id, type: 'mcp', name: data.name || id });
              }
              if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ pending_devices: pendingDevices }));
              return;
          }

          if (name === 'server.approve_device') {
              if (args.type === 'xiaozhi' && devices[args.id] && !devices[args.id].purge_pending) {
                  devices[args.id].status = 'approved';
                  saveDevices();
                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ success: true, note: `Xiaozhi device ${args.id} approved.` }));
              } else if (args.type === 'mcp' && mcpDevices[args.id]) {
                  mcpDevices[args.id].status = 'approved';
                  saveMcpDevices();

                  // Trigger tool discovery for the newly approved MCP device if it's currently connected
                  for (const [ws, info] of mcpClients.entries()) {
                      if (info.id === args.id) {
                          sendMcpRequest(ws, 'tools/list', {}).then(res => {
                              if (res.result && res.result.tools) info.tools = res.result.tools;
                          }).catch(() => {});
                      }
                  }

                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ success: true, note: `MCP device ${args.id} approved.` }));
              } else {
                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ error: `Device ${args.id} of type ${args.type} not found or not pending.` }));
              }
              return;
          }

          if (name === 'server.update_config') {
              let updated = false;
              const toolDef = builtinTools.find(t => t.name === 'server.update_config');
              
              const validate = (param, value) => {
                  const allowed = toolDef.parameters.properties[param]?.enum;
                  if (allowed && !allowed.includes(value)) {
                      return `Invalid value for ${param}: ${value}. Allowed: ${allowed.join(', ')}`;
                  }
                  return null;
              };

              let error;
              if (args.llm_backend && (error = validate('llm_backend', args.llm_backend))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.gemini_model && (error = validate('gemini_model', args.gemini_model))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.qwen_model && (error = validate('qwen_model', args.qwen_model))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.gemini_voice && (error = validate('gemini_voice', args.gemini_voice))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.qwen_voice && (error = validate('qwen_voice', args.qwen_voice))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.llama_model && (error = validate('llama_model', args.llama_model))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));
              if (args.llama_voice && (error = validate('llama_voice', args.llama_voice))) return provider?.sendToolResponse(callId, name, JSON.stringify({ error }));

              if (args.llm_backend && args.llm_backend !== devices[macAddress].llm_backend) {
                  devices[macAddress].llm_backend = args.llm_backend;
                  delete devices[macAddress].gemini_model;
                  delete devices[macAddress].qwen_model;
                  delete devices[macAddress].gemini_voice;
                  delete devices[macAddress].qwen_voice;
                  delete devices[macAddress].llama_model;
                  delete devices[macAddress].llama_voice;
                  updated = true;
              }
              
              if (args.gemini_model) { devices[macAddress].gemini_model = args.gemini_model; updated = true; }
              if (args.qwen_model) { devices[macAddress].qwen_model = args.qwen_model; updated = true; }
              if (args.gemini_voice) { devices[macAddress].gemini_voice = args.gemini_voice; updated = true; }
              if (args.qwen_voice) { devices[macAddress].qwen_voice = args.qwen_voice; updated = true; }
              if (args.llama_model) { devices[macAddress].llama_model = args.llama_model; updated = true; }
              if (args.llama_voice) { devices[macAddress].llama_voice = args.llama_voice; updated = true; }
              if (args.prompt) { devices[macAddress].prompt = args.prompt; updated = true; }

              if (updated) {
                  saveDevices();
                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ success: true, note: "Configuration updated successfully. The changes will take effect the next time a session is started." }));
              } else {
                  if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ note: "No changes provided." }));
              }
              return;
          }

          let targetWs = null;
          for (const [mcpWs, info] of mcpClients.entries()) {              const mcpStatus = mcpDevices[info.id]?.status;
              if (mcpStatus === 'approved' && enabledMcpSet.has(info.id)) {
                  if (info.tools.find(t => t.name === name)) {
                      targetWs = mcpWs;
                      break;
                  }
              }
          }

          if (targetWs) {
              sendMcpRequest(targetWs, 'tools/call', { name, arguments: args })
                  .then(mcpRes => {
                      if (!isCurrentProvider()) return;
                      const resultText = mcpRes.result?.content?.[0]?.text || JSON.stringify(mcpRes.result || { success: true });
                      logger.info(`[${sessionId}] Tool call ${name} succeeded.`);
                      newProvider.sendToolResponse(callId, name, resultText);
                  })
                  .catch(e => {
                      if (!isCurrentProvider()) return;
                      trace.event('tool.error', { attempt, call_id: callId, tool: name, error: e }, 'error');
                      newProvider.sendToolResponse(callId, name, JSON.stringify({ error: e.message }));
                  });
          } else {
              logger.warn(`[${sessionId}] Tool ${name} requested but no valid MCP client has it.`);
              if (provider) provider.sendToolResponse(callId, name, JSON.stringify({ error: "Tool not available." }));
          }
      });

      newProvider.on('error', (err) => {
          if (!isCurrentProvider()) return;
          inboxAnnouncement?.discard();
          trace.event('provider.error', { attempt, backend: activeBackend, model: config.model, phase: provider === newProvider ? 'ready' : 'setup', error: err }, 'error');
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: err.message }));
      });

      newProvider.on('close', (details = {}) => {
          if (!isCurrentProvider()) return;
          const wasReady = provider === newProvider;
          trace.event('provider.closed', { attempt, backend: activeBackend, model: config.model, phase: wasReady ? 'ready' : 'setup',
            code: details.code, reason: details.reason || 'No close reason supplied', was_clean: details.wasClean,
            attempt_ms: Math.round(performance.now() - attemptStarted), pending_tools: [...pendingToolCalls.keys()],
            buffered_frames: audioInput.length, playback_queue: audioOutputQueue.length, idle: voiceIdle.snapshot() }, 'warn');
          // Keep the device channel during bounded recovery. Exhaustion closes
          // voice even with standby disabled, rather than leaving a dead listener.
          provider = null;
          connectingProvider = null;
          providerGeneration++;
          toolAbort.abort();
          voiceIdle.resume();
          inboxAnnouncement?.discard();
          memoryTurns?.discard();
          audioOutputQueue = [];
          outputRemainder = Buffer.alloc(0);
          playbackPrimed = false;
          if (pendingToolCalls.size) resumptionState = null;
          ttsTextQueue = [];
          outputTranscriptionBuffer = '';
          modelDone = false;
          if (isSpeaking && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tts', state: 'stop', session_id: sessionId }));
          }
          isSpeaking = false;
          let reason = String(sanitizeLogValue(details.reason || 'No close reason supplied', [...logSecrets, expectedToken])).replace(/[\r\n]/g, ' ');
          reason = reason.slice(0, 1000);
          logger.warn(`[${sessionId}] Provider session closed: backend=${activeBackend} model=${config.model} phase=${wasReady ? 'ready' : 'setup'} code=${details.code ?? 'unknown'} reason=${reason}`);
          if (config.resumptionHandle && !wasReady && [1007, 1008].includes(details.code)) {
              resumptionState = null;
              details = { ...details, retryable: true };
              trace.event('provider.resumption_rejected', { attempt, fallback: 'fresh_session' }, 'warn');
          }
          const retry = activeBackend === 'gemini' ? recovery.next(details) : null;
          if (retry) {
              voiceIdle.hold('provider_reconnect');
              trace.event('provider.retry_scheduled', { attempt, retry: retry.retry, delay_ms: retry.delayMs, close_code: details.code });
              logger.info(`[${sessionId}] Retrying Gemini connection in ${retry.delayMs / 1000}s (${retry.retry}/5)`);
              providerRetryTimer = setTimeout(() => {
                  providerRetryTimer = null;
                  startSession();
              }, retry.delayMs);
              providerRetryTimer.unref();
          } else if (ws.readyState === WebSocket.OPEN) {
              trace.event('provider.retry_skipped', { attempt, reason: 'retry_exhausted_or_non_transient' }, 'warn');
              ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: `AI connection closed (${details.code ?? 'unknown'}): ${reason}` }));
              finishVoiceSession('provider_unavailable');
          }
      });

      trace.event('provider.connect_requested', { attempt, backend: activeBackend, model: config.model, voice: config.voice,
        tool_count: mcpTools.length, tool_names: mcpTools.map(tool => tool.name),
        input_transcription: Boolean(config.input_transcription), output_transcription: Boolean(config.output_transcription),
        prompt_chars: (config.prompt || '').length });
      logger.info(`[${sessionId}] Starting ${activeBackend} session with ${mcpTools.length} tools.`);
      await newProvider.connect(mcpTools);
      if (sessionClosed) newProvider.close();
      
    } catch (err) {
      trace.event('provider.start_failed', { attempt, error: err, preparation_ms: Math.round(performance.now() - attemptStarted) }, 'error');
      const failedProvider = provider || connectingProvider;
      provider = null;
      connectingProvider = null;
      providerGeneration++;
      toolAbort.abort();
      failedProvider?.close();
      if (!sessionClosed) {
        voiceIdle.resume();
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'error', session_id: sessionId, data: 'Could not start AI session. Check server logs and configuration.' }));
        finishVoiceSession('provider_start_failed');
      }
    } finally {
      sessionStarting = false;
    }
  }

  ws.on('message', (message, isBinary) => {
    if (sessionClosed) return;
    if (isBinary) {
      metrics.input_packets++;
      if (metrics.input_packets === 1) trace.event('audio.first_packet', { bytes: message.length, provider_ready: Boolean(provider) });
      decoder.write(message);
    } else {
      try {
        const data = JSON.parse(message.toString());
        logger.debug(`[${sessionId}] Received Xiaozhi ${data.type || 'message'}`);

        // Handle MCP JSON-RPC responses (can be top-level or wrapped in a Xiaozhi message)
        const possibleMcpData = data.payload || data;
        let mcpId = possibleMcpData.id;
        if (mcpId !== undefined && typeof mcpId === 'string' && !isNaN(Number(mcpId))) {
            mcpId = Number(mcpId);
        }

        if (mcpId !== undefined && mcpCallbacks.has(mcpId)) {
          logger.debug(`[${sessionId}] Found matching MCP callback for ID ${mcpId}`);
          mcpCallbacks.get(mcpId)(possibleMcpData);
          mcpCallbacks.delete(mcpId);
          return;
        }

        if (data.type === 'hello') {
          trace.event('device.hello', { mcp_enabled: Boolean(data.features?.mcp), audio_params: data.audio_params });
          const payload = {
            type: 'hello',
            transport: 'websocket',
            session_id: sessionId,
            audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60 }
          };
          logger.debug(`[${sessionId}] Sending Xiaozhi ${payload.type} ${payload.state || ''}`);
          ws.send(JSON.stringify(payload));

          if (data.features && data.features.mcp) {
            logger.info(`[${sessionId}] MCP features detected. Waiting for tools...`);

            // Cancel the losing timeout after successful discovery, and both
            // timers on teardown. Otherwise a successful setup logs a false 5s timeout.
            if (cancelMcpDiscovery) return;
            mcpDiscoveryPending = true;
            const discoveryStarted = performance.now();
            trace.event('mcp.discovery_started', { timeout_ms: 5000, initial_delay_ms: 1000 });
            const mcpWaitPromise = new Promise(resolve => {
              let timeout = null;
              let settled = false;
              const finish = (outcome = 'completed') => {
                if (settled) return;
                settled = true;
                mcpDiscoveryPending = false;
                clearTimeout(timeout);
                trace.event('mcp.discovery_finished', { outcome, duration_ms: Math.round(performance.now() - discoveryStarted), tool_count: mcpClients.get(ws)?.tools?.length || 0 }, outcome === 'timeout' ? 'warn' : 'info');
                resolve();
              };
              const setupTimer = setTimeout(() => {
                if (sessionClosed) return finish('cancelled');
                logger.info(`[${sessionId}] Initializing MCP for device ${macAddress}`);
                setupMcpClient(ws, macAddress, true).then(() => finish('completed')).catch(e => {
                  if (!sessionClosed) trace.event('mcp.discovery_error', { error: e }, 'error');
                  finish(sessionClosed ? 'cancelled' : 'error');
                });
              }, 1000);
              cancelMcpDiscovery = () => { clearTimeout(setupTimer); finish('cancelled'); };
              const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
              const qwenModel = deviceConfig.qwen_model || QWEN_MODEL;
              if (activeBackend === 'qwen_realtime' || (activeBackend === 'qwen' && qwenModel.includes('realtime'))) {
                logger.info(`[${sessionId}] Skipping tool discovery wait for Qwen Realtime backend.`);
                finish('backend_skipped');
              } else {
                timeout = setTimeout(() => {
                  if (!sessionClosed) logger.warn(`[${sessionId}] MCP tool discovery timed out after 5s`);
                  finish(sessionClosed ? 'cancelled' : 'timeout');
                }, 5000);
              }
            });
            mcpWaitPromise.then(() => {
              if (!sessionClosed && !provider) {
                logger.info(`[${sessionId}] Proceeding to start LLM session.`);
                startSession();
              }
            });
          } else {
            if (!provider) {
              const activeBackend = deviceConfig.llm_backend || LLM_BACKEND;
              startSession();
            }
          }
        } else if (data.type === 'listen' && data.state === 'start' && !provider) {
          trace.event('device.listen_requested', { discovery_pending: mcpDiscoveryPending });
          // An explicit new listen request can retry after a provider failure.
          if (!mcpDiscoveryPending) startSession();
        } else if (data.type === 'listen' && data.state === 'stop') {
          trace.event('device.listen_stopped', { reason: 'device_request' });
          audioInput.requestEnd();
        } else if (data.type === 'audio_gap') {
          const count = Math.min(5, Math.max(0, Number.isInteger(data.frames) ? data.frames : 0));
          const duration = [10, 20, 40, 60].includes(data.frame_duration) ? data.frame_duration : 60;
          metrics.input_gap_frames += count;
          if (count) audioInput.push(Buffer.alloc(count * duration * 32));
          trace.event('audio.input_gap', { frames: count, frame_duration: duration }, 'warn');
        } else if (data.type === 'audio_transport_stats') {
          const stats = {};
          for (const key of ['received', 'forwarded', 'late', 'duplicates', 'reordered', 'missing', 'pending']) {
            if (Number.isSafeInteger(data.stats?.[key]) && data.stats[key] >= 0) stats[key] = data.stats[key];
          }
          trace.event('audio.udp_stats', stats);
        } else if (data.type === 'abort') {
          reminderInputOpen = false;
          trace.event('device.abort', { speaking: isSpeaking, playback_queue: audioOutputQueue.length });
          voiceIdle.release('response');
          voiceIdle.release('playback');
          voiceIdle.activity();
          inboxAnnouncement?.discard();
          memoryTurns?.discard();
          outputTranscriptionBuffer = '';
          logger.info(`[${sessionId}] Received abort from device. Clearing queues.`);
          if (provider && typeof provider.interrupt === 'function') {
            provider.interrupt();
          }
          if (isSpeaking) {
            isSpeaking = false;
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'tts', state: 'stop', session_id: sessionId }));
            }
          }
          modelDone = false;
          audioOutputQueue = [];
          outputRemainder = Buffer.alloc(0);
          playbackPrimed = false;
          ttsTextQueue = [];
        }
      } catch (e) { trace.event('device.message_error', { error: e }, 'warn'); }
    }
  });

  function finishVoiceSession(reason) {
    if (sessionClosed) return;
    finishReason = reason;
    trace.event('session.standby', { reason, idle: voiceIdle.snapshot(), metrics });
    logger.info(`[${sessionId}] Returning device to standby: ${reason}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'listen', state: 'stop', session_id: sessionId }));
      ws.send(JSON.stringify({ type: 'goodbye', session_id: sessionId }));
    }
    invalidateVoiceSession();
    ws.close(1000, reason);
    // A silent peer must not hold the voice slot (and reminders) indefinitely.
    const deadline = setTimeout(() => ws.terminate(), 1500);
    deadline.unref();
    ws.once('close', () => clearTimeout(deadline));
  }

  function invalidateVoiceSession(reason) {
    if (sessionClosed) return;
    if (reason) finishReason = reason;
    // Clear/disable invalidates immediately, before the websocket close handshake.
    trace.event('session.teardown', { reason: finishReason || 'device_disconnected', metrics });
    sessionClosed = true;
    clearInterval(traceInterval);
    deviceHeartbeat?.stop();
    audioInput.stop();
    resumptionState = null;
    toolHistory.clear();
    voiceIdle.stop();
    if (providerRetryTimer) clearTimeout(providerRetryTimer);
    providerRetryTimer = null;
    cancelMcpDiscovery?.();
    providerGeneration++;
    providerToolAbort?.abort();
    inboxAnnouncement?.discard();
    memoryTurns?.close();
    (provider || connectingProvider)?.close();
    provider = null;
    connectingProvider = null;
    audioOutputQueue = [];
    outputRemainder = Buffer.alloc(0);
    ttsTextQueue = [];
    outputTranscriptionBuffer = '';
    if (audioSendInterval) clearInterval(audioSendInterval);
    audioSendInterval = null;
    decoder.destroy();
    encoder.destroy();
  }
  voiceTeardowns.set(ws, invalidateVoiceSession);
  ws.on('error', error => trace.event('device.socket_error', { error }, 'error'));
  ws.on('close', (code, reason) => {
    trace.event('device.disconnected', { code, reason: reason.toString(), server_reason: finishReason, metrics });
    invalidateVoiceSession();
    voiceTeardowns.delete(ws);
    voiceTraces.delete(ws);
    activeVoiceSockets.get(macAddress)?.delete(ws);
    if (!activeVoiceSockets.get(macAddress)?.size) activeVoiceSockets.delete(macAddress);
    logger.info(`[${sessionId}] Client disconnected`);
    mcpClients.delete(ws);
  });

  deviceHeartbeat = startSocketHeartbeat(ws, {
    onEvent: (event, fields, level) => trace.event(event, fields, level),
    onTimeout: reason => {
      // Invalidate before terminating: don't wait for a dead peer's close reply
      // to release Gemini, pending tools, audio buffers and session timers.
      invalidateVoiceSession(reason);
      ws.terminate();
    }
  });

  // startGeminiSession(); // Removed immediate start
});

server.listen(PORT, HOST, () => {
  logger.info('Server diagnostics:', { node_version: process.version, pid: process.pid,
    log_level: logger.level, voice_idle_default_seconds: VOICE_IDLE_TIMEOUT_SECONDS,
    voice_activity_threshold: VOICE_ACTIVITY_THRESHOLD, session_status_interval_ms: 15000 });
  logger.info(`Parrot Server listening on ${HOST}:${PORT}`);
  logger.info(`Web UI: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/`);
  logger.info(`MCP Endpoint: ws://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}/mcp`);
});

// Drain completed memory writes; incomplete turns are intentionally discarded.
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(retentionTimer);
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  server.close();
  for (const ws of wssXiaozhi.clients) { voiceTeardowns.get(ws)?.('server_shutdown'); ws.terminate(); }
  for (const ws of wssMcp.clients) ws.terminate();
  for (const ws of wssMcpEndpoint.clients) ws.terminate();
  await watcher.close();
  await notificationReminders.close();
  await screenBreaks.close();
  await screenTts.close();
  await reminderService.close();
  await endpointMcp?.close();
  await remoteMcp?.close();
  try { await Promise.all([memoryStore.close(),notificationInbox.close()]); }
  catch { logger.error('Failed to flush memory during shutdown.'); process.exitCode = 1; }
  logger.end();
  clearTimeout(deadline);
  process.exit(process.exitCode || 0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
