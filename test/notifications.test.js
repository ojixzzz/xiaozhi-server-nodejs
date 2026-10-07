'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  NotificationService, NotificationError, fromEnvironment, validateRpcAdapter,
  validateNotifyPayload, LIMITS
} = require('../lib/notifications');

const origin = 'https://audio.example.com';
const input = { audio_url: `${origin}/notice.ogg` };
const policy = { allowedAudioOrigins: [origin] };
function service(options = {}) {
  return new NotificationService({
    enabled: true,
    rpc: async () => ({ success: true }),
    resolveDevice: () => ({ status: 'approved' }),
    clientIds: { device1: 'GID_test@@@aa_bb_cc_dd_ee_ff@@@owner', device2: 'different-client' },
    ...policy,
    minIntervalMs: 0,
    ...options
  });
}
const rejectsCode = (promise, code) => assert.rejects(promise, error =>
  error instanceof NotificationError && error.code === code);
const throwsCode = (fn, code) => assert.throws(fn, error =>
  error instanceof NotificationError && error.code === code);

test('disabled by default; missing configuration fails closed without RPC', async () => {
  const disabled = new NotificationService();
  assert.equal(disabled.status().enabled, false);
  assert.equal(disabled.status().configured, false);
  await rejectsCode(disabled.send('device1', input), 'NOTIFICATIONS_DISABLED');
  const missing = service({ rpc: undefined });
  await rejectsCode(missing.send('device1', input), 'NOTIFICATIONS_NOT_CONFIGURED');
  assert.deepEqual(missing.status().missing, ['adapter']);
});

test('forwards only the documented envelope and uses explicit mapped client ID', async () => {
  let envelope;
  let contextSeen;
  const sender = service({
    rpc: async (value, options) => {
      envelope = value;
      assert.ok(options.signal instanceof AbortSignal);
      return { success: true };
    },
    resolveDevice: (id, context) => { contextSeen = { id, context }; return { status: 'approved' }; }
  });
  const result = await sender.send('device1', {
    ...input,
    subtitles: [{ start_ms: 200, text: '第二句' }, { start_ms: 0, text: '第一句' }],
    idempotencyKey: 'job:one', expiresAt: Date.now() + 5000
  }, { user: 'owner' });
  assert.deepEqual(envelope, {
    method: 'forward', clientId: 'GID_test@@@aa_bb_cc_dd_ee_ff@@@owner',
    params: { type: 'notify', ...input, subtitles: [{ start_ms: 0, text: '第一句' }, { start_ms: 200, text: '第二句' }] }
  });
  assert.deepEqual(contextSeen, { id: 'device1', context: { user: 'owner' } });
  assert.equal(result.status, 'published');
  assert.equal(result.playback, 'unknown');
  assert.equal(result.duplicate, false);
  assert.ok(result.id);
  assert.equal(sender.status().playbackAcknowledgement, false);
});

test('requires ownership supplied by resolver, approved device, and explicit mapping', async () => {
  let calls = 0;
  for (const resolveDevice of [() => null, () => ({ status: 'pending' }), () => ({ approved: true })]) {
    const sender = service({ resolveDevice, rpc: () => { calls++; } });
    await rejectsCode(sender.send('device1', input), 'DESTINATION_NOT_ALLOWED');
  }
  await rejectsCode(service().send('unmapped', input), 'DESTINATION_NOT_ALLOWED');
  assert.equal(calls, 0);
});

test('rejects requester-supplied client IDs, arbitrary methods, metadata and malformed IDs', async () => {
  for (const field of ['clientId', 'method', 'type', 'params', 'state', 'kind', 'notification_id']) {
    await rejectsCode(service().send('device1', { ...input, [field]: 'forbidden' }), 'INVALID_INPUT');
  }
  await rejectsCode(service().send('__proto__', input), 'INVALID_INPUT');
  await rejectsCode(service().send('device1', { ...input, idempotencyKey: '\n' }), 'INVALID_INPUT');
});

test('strict origin allowlist and HTTPS-only default; no audio fetching', () => {
  assert.deepEqual(validateNotifyPayload(input, policy), { type: 'notify', ...input });
  for (const audio_url of [
    'http://audio.example.com/a.ogg', 'https://audio.example.com.evil.test/a.ogg',
    'https://user:password@audio.example.com/a.ogg', 'https://audio.example.com/a.ogg#fragment',
    'https://audio.example.com/a.ogg#',
    'file:///etc/passwd', 'data:audio/ogg;base64,xx', '/relative.ogg',
    'https://audio.example.com:8443/a.ogg', ' https://audio.example.com/a.ogg',
    'https:\\audio.example.com\\a.ogg', 'https://audio.example.com/a\n.ogg',
    `https://audio.example.com/${'a'.repeat(LIMITS.urlBytes)}`
  ]) {
    throwsCode(() => validateNotifyPayload({ audio_url }, policy), 'INVALID_AUDIO_URL');
  }
  const local = { audio_url: 'http://192.168.1.10/audio.ogg' };
  assert.equal(validateNotifyPayload(local, {
    allowHttp: true, allowedAudioOrigins: ['http://192.168.1.10']
  }).audio_url, local.audio_url);
});

test('subtitles validate types, timing, controls, UTF-8 byte limits and aggregate size', () => {
  for (const subtitles of [null, {}, [null], [{ start_ms: -1, text: 'x' }],
    [{ start_ms: 0.5, text: 'x' }], [{ start_ms: '0', text: 'x' }],
    [{ start_ms: LIMITS.subtitleStartMs + 1, text: 'x' }],
    [{ start_ms: 0, text: '' }], [{ start_ms: 0, text: ' ' }],
    [{ start_ms: 0, text: '\u0000' }], [{ start_ms: 0, text: '字'.repeat(200) }],
    Array.from({ length: LIMITS.subtitles + 1 }, () => ({ start_ms: 0, text: 'x' }))]) {
    assert.throws(() => validateNotifyPayload({ ...input, subtitles }, policy), NotificationError);
  }
  throwsCode(() => validateNotifyPayload({ ...input, subtitles: Array.from({ length: 30 },
    () => ({ start_ms: 0, text: 'a'.repeat(400) })) }, policy), 'PAYLOAD_TOO_LARGE');
  assert.deepEqual(validateNotifyPayload({ ...input, subtitles: [] }, policy).subtitles, []);
});

test('expires locally before forwarding and never adds expiry to the wire payload', async () => {
  let time = 100000;
  let calls = 0;
  const sender = service({ now: () => time, rpc: () => { calls++; return { success: true }; } });
  await rejectsCode(sender.send('device1', { ...input, expiresAt: time }), 'NOTIFICATION_EXPIRED');
  await rejectsCode(sender.send('device1', { ...input, expiresAt: time + LIMITS.maxFutureMs + 1 }), 'INVALID_EXPIRY');
  await rejectsCode(sender.send('device1', { ...input, expiresAt: '2026-10-07' }), 'INVALID_EXPIRY');
  const slowResolver = service({ now: () => time, resolveDevice: () => {
    time += 40000; return { status: 'approved' };
  }, rpc: () => { calls++; } });
  await rejectsCode(slowResolver.send('device1', input), 'NOTIFICATION_EXPIRED');
  assert.equal(calls, 0);
});

test('idempotency joins concurrent sends, retains result, and rejects content collisions', async () => {
  let complete;
  let calls = 0;
  const sender = service({ rpc: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  const request = { ...input, idempotencyKey: 'same-job' };
  const first = sender.send('device1', request);
  const second = sender.send('device1', request);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  complete({ success: true });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id);
  assert.equal(b.duplicate, true);
  assert.equal((await sender.send('device1', request)).duplicate, true);
  await rejectsCode(sender.send('device1', { ...request, audio_url: `${origin}/other.ogg` }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(calls, 1);
});

test('rechecks authorization even on an idempotent retry', async () => {
  let approved = true;
  const sender = service({ resolveDevice: () => ({ status: approved ? 'approved' : 'pending' }) });
  const request = { ...input, idempotencyKey: 'job' };
  await sender.send('device1', request);
  approved = false;
  await rejectsCode(sender.send('device1', request), 'DESTINATION_NOT_ALLOWED');
});

test('idempotency is scoped per device and expires; capacity remains bounded', async () => {
  let time = 100000;
  let calls = 0;
  const sender = service({ now: () => time, maxEntries: 2, dedupeTtlMs: 1000,
    rpc: () => { calls++; return { success: true }; } });
  const request = { ...input, idempotencyKey: 'job' };
  await sender.send('device1', request);
  await sender.send('device2', request);
  assert.equal(calls, 2);
  await rejectsCode(sender.send('device1', { ...input, idempotencyKey: 'next' }), 'NOTIFICATION_CAPACITY');
  time += 1001;
  assert.equal((await sender.send('device1', request)).duplicate, false);
  assert.equal(calls, 3);
  assert.equal(sender.records.size, 1);
});

test('rate limits per device and allows idempotent retries', async () => {
  let time = 100000;
  const sender = service({ now: () => time, minIntervalMs: 1000 });
  const request = { ...input, idempotencyKey: 'job' };
  await sender.send('device1', request);
  assert.equal((await sender.send('device1', request)).duplicate, true);
  await rejectsCode(sender.send('device1', input), 'NOTIFICATION_RATE_LIMIT');
  await sender.send('device2', input);
  time += 1000;
  assert.equal((await sender.send('device1', input)).status, 'published');
});

test('only explicit gateway true/false results claim publication state', async () => {
  for (const [rpc, expected, reason] of [
    [() => ({ success: false }), 'not_published', 'gateway_did_not_publish'],
    [() => undefined, 'unknown', 'unrecognized_gateway_result'],
    [() => ({ success: 'true' }), 'unknown', 'unrecognized_gateway_result'],
    [() => ({ result: { success: true } }), 'unknown', 'unrecognized_gateway_result'],
    [() => { throw new Error('private credential must not be exposed'); }, 'unknown', 'gateway_error']
  ]) {
    const result = await service({ rpc }).send('device1', input);
    assert.equal(result.status, expected);
    assert.equal(result.reason, reason);
    assert.equal(result.playback, 'unknown');
    assert.ok(!JSON.stringify(result).includes('credential'));
  }
});

test('timeouts abort, stay unknown, do not retry, and bound unresolved transport calls', async () => {
  let signal;
  let calls = 0;
  const sender = service({ timeoutMs: 5, maxPending: 1, rpc: (_request, options) => {
    signal = options.signal; calls++; return new Promise(() => {});
  } });
  const request = { ...input, idempotencyKey: 'job' };
  const result = await sender.send('device1', request);
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'gateway_timeout');
  assert.equal(signal.aborted, true);
  assert.equal((await sender.send('device1', request)).duplicate, true);
  await rejectsCode(sender.send('device2', input), 'NOTIFICATION_CAPACITY');
  assert.equal(calls, 1);
});

test('concurrent distinct sends cannot exceed pending capacity', async () => {
  let finish;
  let calls = 0;
  const sender = service({ maxPending: 1, rpc: () => {
    calls++; return new Promise(resolve => { finish = resolve; });
  } });
  const first = sender.send('device1', input);
  await rejectsCode(sender.send('device2', input), 'NOTIFICATION_CAPACITY');
  finish({ success: true });
  await first;
  assert.equal(calls, 1);
});

test('late gateway completion releases capacity but does not rewrite an unknown attempt', async () => {
  let complete;
  const sender = service({ timeoutMs: 5, maxPending: 1,
    rpc: () => new Promise(resolve => { complete = resolve; }) });
  const request = { ...input, idempotencyKey: 'late-job' };
  const initial = await sender.send('device1', request);
  assert.equal(initial.status, 'unknown');
  assert.equal(sender.pending, 1);
  complete({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sender.pending, 0);
  const retry = await sender.send('device1', request);
  assert.equal(retry.status, 'unknown');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.id, initial.id);
});

test('environment config and adapter exports are validated without loading request-selected code', () => {
  const sender = fromEnvironment({
    NOTIFY_ENABLED: 'true', NOTIFY_CLIENT_IDS_JSON: '{"device1":"client-one"}',
    NOTIFY_ALLOWED_AUDIO_ORIGINS: origin, NOTIFY_TIMEOUT_MS: '1500'
  }, { rpc: validateRpcAdapter({ rpc: () => ({ success: true }) }), resolveDevice: () => ({ status: 'approved' }) });
  assert.equal(sender.status().configured, true);
  assert.equal(sender.timeoutMs, 1500);
  assert.equal(fromEnvironment({}).status().enabled, false);
  for (const env of [{ NOTIFY_ENABLED: '1' }, { NOTIFY_ALLOW_HTTP: 'yes' },
    { NOTIFY_CLIENT_IDS_JSON: '[]' }, { NOTIFY_CLIENT_IDS_JSON: 'broken' },
    { NOTIFY_TIMEOUT_MS: '5junk' }, { NOTIFY_TIMEOUT_MS: '999999' },
    { NOTIFY_ALLOWED_AUDIO_ORIGINS: `${origin}/not-an-origin` }]) {
    throwsCode(() => fromEnvironment(env), 'INVALID_CONFIG');
  }
  for (const adapter of [undefined, {}, { rpc: true }]) {
    throwsCode(() => validateRpcAdapter(adapter), 'INVALID_CONFIG');
  }
  assert.equal(validateRpcAdapter({ value: 42, rpc() { return this.value; } })(), 42);
  throwsCode(() => service({ clientIds: { one: 'same', two: 'same' } }), 'INVALID_CONFIG');
  throwsCode(() => service({ maxEntries: Infinity }), 'INVALID_CONFIG');
  throwsCode(() => service({ allowedAudioOrigins: ['http://localhost'] }), 'INVALID_CONFIG');
});
