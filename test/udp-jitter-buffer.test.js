'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { UdpJitterBuffer } = require('../lib/udp-jitter-buffer');

function fixture() {
  let time = 0, callback;
  const output = [], gaps = [];
  const jitter = new UdpJitterBuffer({ now: () => time, onPacket: (data, sequence) => output.push(sequence),
    onGap: count => gaps.push(count), setTimer: fn => { callback = fn; return 1; }, clearTimer: () => {} });
  return { jitter, output, gaps, advance: ms => { time += ms; callback?.(); } };
}
test('reorders 1,3,2 without duplication or waiting on contiguous audio', () => {
  const f = fixture();
  f.jitter.push(1, Buffer.from('a')); assert.deepEqual(f.output, [1]);
  f.jitter.push(3, Buffer.from('c')); f.jitter.push(3, Buffer.from('c'));
  assert.deepEqual(f.output, [1]);
  f.jitter.push(2, Buffer.from('b')); f.jitter.push(1, Buffer.from('a'));
  assert.deepEqual(f.output, [1, 2, 3]); assert.deepEqual(f.gaps, []);
  assert.equal(f.jitter.snapshot().duplicates, 1); assert.equal(f.jitter.snapshot().late, 1);
  f.jitter.stop();
});
test('missing packets expire after 120 ms and cannot be replayed later', () => {
  const f = fixture(); f.jitter.push(1, Buffer.alloc(1)); f.jitter.push(3, Buffer.alloc(1));
  f.advance(119); assert.deepEqual(f.output, [1]);
  f.advance(1); assert.deepEqual(f.output, [1, 3]); assert.deepEqual(f.gaps, [1]);
  assert.equal(f.jitter.push(2, Buffer.alloc(1)), false);
  f.jitter.stop();
});
test('large jumps remain bounded, flush orders pending packets, stop cancels them', () => {
  const f = fixture();
  for (let seq = 100; seq < 140; seq++) f.jitter.push(seq, Buffer.alloc(1));
  assert.ok(f.jitter.pending.size <= 32);
  f.jitter.flush(); assert.equal(f.output.at(-1), 139);
  assert.equal(f.gaps.reduce((a, b) => a + b, 0), 99);
  f.jitter.push(145, Buffer.alloc(1)); f.jitter.stop(); f.advance(120);
  assert.equal(f.output.at(-1), 139);
});
