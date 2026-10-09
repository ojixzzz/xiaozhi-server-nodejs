'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PacedAudioInput } = require('../lib/paced-audio-input');

function fixture() {
  let now = 0, ready = true, callback;
  const sent = [], ends = [], drops = [];
  const input = new PacedAudioInput({ now: () => now, ready: () => ready,
    send: data => sent.push(Buffer.from(data)), end: () => { ends.push(now); return true; },
    onDrop: count => drops.push(count), setTimer: fn => { callback = fn; return 1; }, clearTimer: () => {} });
  return { input, sent, ends, drops, ready: value => { ready = value; }, tick: (ms = 20) => { now += ms; callback(); } };
}
test('reconnect drains one PCM frame per tick, then exactly one end marker', () => {
  const f = fixture(); f.ready(false);
  const pcm = Buffer.alloc(1920, 7); f.input.push(pcm); f.input.requestEnd();
  f.tick(); assert.equal(f.sent.length, 0);
  f.ready(true);
  f.tick(); assert.equal(f.sent.length, 1); assert.equal(f.ends.length, 0);
  f.tick(); f.tick(); f.tick(); f.tick();
  assert.deepEqual(Buffer.concat(f.sent), pcm); assert.equal(f.ends.length, 1);
  f.input.stop();
});
test('an audio gap flushes a partial frame and stale unsent input stays bounded', () => {
  const f = fixture(); f.input.push(Buffer.alloc(320, 1)); f.tick(1200); f.tick();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].length, 640);
  assert.equal(f.sent[0].subarray(320).every(byte => byte === 0), true);
  assert.equal(f.ends.length, 1);
  f.ready(false); f.input.push(Buffer.alloc(640 * 200));
  assert.equal(f.input.length, 150);
  f.tick(4000); assert.equal(f.input.length, 0);
  assert.equal(f.drops.reduce((a, b) => a + b, 0), 200);
  f.input.stop();
});
test('teardown discards queued audio and prevents later timer work', () => {
  const f = fixture(); f.input.push(Buffer.alloc(1920)); f.input.stop(); f.tick(5000);
  assert.equal(f.sent.length, 0); assert.equal(f.ends.length, 0); assert.equal(f.input.length, 0);
});
