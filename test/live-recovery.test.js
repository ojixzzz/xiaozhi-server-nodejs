'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveRecovery, transientError } = require('../lib/live-recovery');

test('recovery backs off, stops after five retries, and resets only after stable readiness', () => {
  let now = 0;
  const recovery = new LiveRecovery({ now: () => now });
  for (const delay of [1000, 2000, 4000, 8000, 15000]) {
    recovery.connected(); now += 100;
    assert.equal(recovery.next({ code: 1006 }).delayMs, delay);
  }
  assert.equal(recovery.next({ code: 1006 }), null);
  recovery.connected(); now += 30000;
  assert.deepEqual(recovery.next({ code: 1006 }), { retry: 1, delayMs: 1000 });
});
test('schema/auth errors stop; nested network errors and HTTP throttling can retry', () => {
  assert.equal(new LiveRecovery().next({ code: 1007 }), null);
  assert.equal(new LiveRecovery().next({ code: 1008 }), null);
  assert.equal(new LiveRecovery().next({ code: 1006, retryable: false }), null);
  assert.equal(transientError(new Error('request failed', { cause: { code: 'ETIMEDOUT' } })), true);
  assert.equal(transientError({ status: 429 }), true);
  assert.equal(transientError({ status: 403, message: 'Forbidden' }), false);
  assert.equal(transientError(new Error('Invalid API configuration')), false);
});
