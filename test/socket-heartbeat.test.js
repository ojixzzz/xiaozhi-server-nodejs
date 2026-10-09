'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startSocketHeartbeat } = require('../lib/socket-heartbeat');

function fixture() {
  let time = 0, tick, clears = 0;
  const events = [], timeouts = [];
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.pings = 0;
  ws.ping = (_data, _mask, callback) => { ws.pings++; ws.lastCallback = callback; };
  const heartbeat = startSocketHeartbeat(ws, {
    now: () => time, setTimer: (callback, interval) => { assert.equal(interval, 5000); tick = callback; return { unref() {} }; },
    clearTimer: () => { clears++; }, onTimeout: reason => timeouts.push(reason),
    onEvent: (event, fields) => events.push({ event, ...fields })
  });
  return { ws, heartbeat, events, timeouts, clears: () => clears,
    advance: milliseconds => { time += milliseconds; tick(); } };
}

test('a powered-off peer expires despite an OPEN socket and disabled speech timeout', () => {
  const f = fixture();
  for (let index = 0; index < 5; index++) f.advance(5000);
  assert.equal(f.ws.pings, 5);
  assert.deepEqual(f.timeouts, [], 'one missing pong does not end a connection immediately');
  f.advance(5000);
  assert.deepEqual(f.timeouts, ['device_heartbeat_timeout']);
  assert.equal(f.events.at(-1).event, 'device.heartbeat_timeout');
  assert.equal(f.events.at(-1).last_pong_age_ms, 30000);
  assert.equal(f.events.at(-1).timeout_ms, 30000);
  assert.equal(f.clears(), 1);
  assert.equal(f.ws.listenerCount('pong'), 0);
  f.advance(5000); f.ws.lastCallback(new Error('late send failure'));
  assert.equal(f.timeouts.length, 1, 'expiry is idempotent, including late ping callbacks');
});

test('delayed pong preserves a silent peer and starts a fresh liveness window', () => {
  const f = fixture();
  f.advance(5000); f.advance(5000);
  f.ws.emit('pong');
  f.advance(10000); f.advance(10000);
  assert.deepEqual(f.timeouts, []);
  assert.equal(f.heartbeat.snapshot().last_pong_age_ms, 20000);
  f.ws.emit('pong');
  f.advance(5000);
  assert.deepEqual(f.timeouts, []);
  assert.equal(f.heartbeat.snapshot().pong_received, true);
  f.heartbeat.stop();
});

test('normal disconnect and explicit teardown remove heartbeat timers and listeners', () => {
  for (const cause of ['close', 'teardown']) {
    const f = fixture();
    if (cause === 'close') { f.ws.readyState = 3; f.ws.emit('close'); }
    else f.heartbeat.stop();
    f.heartbeat.stop(); f.advance(120000);
    assert.equal(f.clears(), 1);
    assert.equal(f.ws.pings, 0);
    assert.deepEqual(f.timeouts, []);
    assert.equal(f.ws.listenerCount('pong'), 0);
    assert.equal(f.ws.listenerCount('close'), 0);
  }
});

test('ping write failure cleans up exactly once, including a synchronous exception', () => {
  for (const synchronous of [false, true]) {
    const f = fixture();
    const error = new Error('Socket write failed');
    if (synchronous) f.ws.ping = () => { throw error; };
    f.advance(5000);
    if (!synchronous) f.ws.lastCallback(error);
    assert.deepEqual(f.timeouts, ['device_heartbeat_send_failed']);
    assert.equal(f.events.at(-1).error, error);
    assert.equal(f.clears(), 1);
    f.advance(30000);
    assert.equal(f.timeouts.length, 1);
  }
});
