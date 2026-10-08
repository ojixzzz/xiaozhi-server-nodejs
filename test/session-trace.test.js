'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeLogValue, formatLogEntry, createSessionTrace } = require('../lib/session-trace');

test('session diagnostics redact credentials and contents while keeping actionable error details', () => {
  const cause = new Error('WebSocket failed at wss://example.test/live?key=hidden-key');
  cause.code = 'ECONNRESET';
  const error = new Error('Bearer hidden-bearer and private-device-token', { cause });
  const clean = sanitizeLogValue({ error, prompt: 'private prompt', arguments: { text: 'private title' },
    apiKey: 'hidden-key', authToken: 'hidden-token', audio: Buffer.alloc(2),
    endpoint: 'https://user:password@example.test/mcp?token=hidden-token', tool_count: 14 }, ['private-device-token']);
  const json = JSON.stringify(clean);
  for (const secret of ['hidden-key', 'hidden-token', 'hidden-bearer', 'private-device-token', 'private prompt', 'private title', 'user:password']) {
    assert.equal(json.includes(secret), false, secret);
  }
  assert.equal(clean.error.cause.code, 'ECONNRESET');
  assert.match(clean.error.stack, /session-trace.test/);
  assert.equal(clean.tool_count, 14);
});

test('Winston additional Error arguments include name, stack, code and cause', () => {
  const cause = new Error('TCP reset'); cause.code = 'ECONNRESET';
  const error = new Error('Provider failed', { cause });
  const line = formatLogEntry({ timestamp: 'test-time', level: 'error', message: '[session] Provider error:',
    [Symbol.for('splat')]: [error] });
  assert.match(line, /Provider failed/); assert.match(line, /ECONNRESET/); assert.match(line, /stack/);
  assert.equal(line.split('\n').length, 1, 'stack stays on one physical log line');
});

test('session trace correlates retry attempts with monotonic durations and event order', () => {
  let time = 100, attempt = 1;
  const logs = [];
  const trace = createSessionTrace({ logger: { log: (level, message) => logs.push({ level, message }) },
    sessionId: 'session-one', deviceId: 'device-one', context: () => ({ attempt }), now: () => time });
  trace.event('gemini.socket_open');
  time += 104; trace.event('provider.closed', { code: 1008, reason: 'Invalid model' }, 'warn');
  attempt = 2; time += 1000; trace.event('provider.preparing');
  const rows = logs.map(log => JSON.parse(log.message.slice(log.message.indexOf('trace ') + 6)));
  assert.deepEqual(rows.map(row => row.seq), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.elapsed_ms), [0, 104, 1104]);
  assert.deepEqual(rows.map(row => row.attempt), [1, 1, 2]);
  assert.ok(rows.every(row => row.session_id === 'session-one' && row.device_id === 'device-one'));
  assert.equal(logs[1].level, 'warn');
});

test('cyclic diagnostics do not break the logger', () => {
  const data = { code: 'failed' }; data.self = data;
  assert.equal(sanitizeLogValue(data).self, '[circular]');
});
