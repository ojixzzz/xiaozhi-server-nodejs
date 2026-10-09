'use strict';

const { performance } = require('node:perf_hooks');
const PRIVATE_FIELD = /^(?:.*token|.*password|.*secret|api[_-]?key|authorization|cookie|prompt|transcript|text|audio|content|arguments|args|result|payload|resumptionHandle|newHandle|resumptionSignature)$/i;

// Keep diagnostics useful without copying credentials or conversation contents.
function sanitizeLogValue(value, secrets = [], seen = new WeakSet(), depth = 0) {
  if (typeof value === 'string') {
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length >= 4) value = value.split(secret).join('[redacted]');
    }
    return value
      .replace(/([?&](?:key|api_key|token|access_token)=)[^\s&#"']+/gi, '$1[redacted]')
      .replace(/(Bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
      .replace(/(https?:\/\/|wss?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
      .slice(0, 12000);
  }
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (Buffer.isBuffer(value)) return { bytes: value.length };
  if (depth > 6) return '[depth limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let data = value;
  if (value instanceof Error || typeof value.stack === 'string' && typeof value.message === 'string') {
    data = { name: value.name, message: value.message, code: value.code, stack: value.stack, cause: value.cause };
  }
  if (Array.isArray(data)) return data.slice(0, 100).map(item => sanitizeLogValue(item, secrets, seen, depth + 1));
  const clean = {};
  for (const [key, item] of Object.entries(data).slice(0, 100)) {
    clean[key] = PRIVATE_FIELD.test(key) ? '[redacted]' : sanitizeLogValue(item, secrets, seen, depth + 1);
  }
  return clean;
}

function formatLogEntry(info, secrets = []) {
  const message = sanitizeLogValue(info.message, secrets);
  const extra = info[Symbol.for('splat')] || [];
  const metadata = Object.fromEntries(Object.entries(info).filter(([key]) => !['timestamp', 'level', 'message'].includes(key)));
  const details = extra.length ? extra : Object.keys(metadata).length ? [metadata] : [];
  const line = typeof message === 'string' ? message.replace(/[\r\n]/g, character => character === '\n' ? '\\n' : '\\r') : JSON.stringify(message);
  return `[${info.timestamp}] ${String(info.level).toUpperCase()}: ${line}${details.length ? ' ' + JSON.stringify(sanitizeLogValue(details, secrets)) : ''}`;
}

function createSessionTrace({ logger, sessionId, deviceId, context = () => ({}), secrets = [], now = () => performance.now() }) {
  const started = now();
  let sequence = 0;
  return {
    event(event, fields = {}, level = 'info') {
      const data = sanitizeLogValue({ ...context(), ...fields, event, seq: ++sequence,
        session_id: sessionId, device_id: deviceId, elapsed_ms: Math.round(now() - started) }, secrets);
      logger.log(level, `[${sessionId}] trace ${JSON.stringify(data)}`);
    }
  };
}

module.exports = { sanitizeLogValue, formatLogEntry, createSessionTrace };
